/**
 * Deferred turn starts - a `thread.turn.start` sent with `whenBusy: "queue"`
 * that found its thread busy.
 *
 * The decider holds such a start on the thread and decides, on every later
 * command for that thread, whether it now starts, still waits, or is dropped:
 *
 * - It starts when the thread becomes free after a turn ended normally, in the
 *   same command that freed it, so nothing can start a turn in between. One
 *   starts per transition; the next waits for that turn to end.
 * - It is dropped, with a `thread.deferred-turn-start-dropped` event saying
 *   why, when the turn it waits on ends any other way: Stop, a stopped,
 *   interrupted or failed session, a failed turn start, or the thread being
 *   archived or deleted. A turn nobody asked for never starts after a Stop.
 *
 * "Free" needs no clock. The command model tracks the turn start the server has
 * asked a provider for (`pendingTurnStart`) and clears it on the events that
 * settle it, so every clearing event is a moment the thread can become free.
 * `pendingTurnStart` is not persisted: after a restart the provider reactor
 * sends `thread.deferred-turn-start.release` for threads that are free.
 *
 * A deferred turn start may carry an environment. The engine keeps it in
 * memory, never on an event, and hands it to the provider reactor when the
 * start runs, exactly as for a direct start. The deferred turn start records
 * only that it had one, so one whose environment died with a restart is
 * dropped with `environment-lost` when it would run, rather than run without it.
 *
 * @module deferredTurnStarts
 */
import type {
  CommandId,
  DeferredTurnStartDropReason,
  OrchestrationCommand,
  OrchestrationDeferredTurnStart,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { DeciderContext } from "./DeciderContext.ts";
import type { OrchestrationCommandRejection, OrchestrationProjectorDecodeError } from "./Errors.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
// Omit over the union loses the `type` narrowing, so events are read through this.
type PlannedEventOf<Type extends OrchestrationEvent["type"]> = Omit<
  Extract<OrchestrationEvent, { type: Type }>,
  "sequence"
>;
type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

type EventBase = (input: {
  readonly aggregateKind: "thread";
  readonly aggregateId: ThreadId;
  readonly occurredAt: string;
  readonly commandId: CommandId;
}) => Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
>;

type Decide = (
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
) => Effect.Effect<
  PlannedEvent | ReadonlyArray<PlannedEvent>,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
>;

type Project = (
  readModel: OrchestrationReadModel,
  event: OrchestrationEvent,
) => Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError>;

/** No turn is running or starting and none has been asked for. */
export function threadIsFree(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return (
    (status === undefined || status === "ready" || status === "idle") &&
    (thread.pendingTurnStart ?? null) === null
  );
}

/** A start that asks to queue waits behind anything busy and behind earlier waiting starts. */
function turnStartMustWait(thread: OrchestrationThread): boolean {
  return !threadIsFree(thread) || (thread.deferredTurnStarts?.length ?? 0) > 0;
}

function activityRequestId(payload: unknown): string | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    "requestId" in payload &&
    typeof payload.requestId === "string"
    ? payload.requestId
    : undefined;
}

/**
 * The command model's share of the fields this module owns. Runs after the
 * main projector for every event.
 */
export function projectDeferredTurnStarts(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  const update = (
    threadId: ThreadId,
    patch: (thread: OrchestrationThread) => Partial<OrchestrationThread> | null,
  ): OrchestrationReadModel => {
    let changed = false;
    const threads = model.threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      const next = patch(thread);
      if (next === null) return thread;
      changed = true;
      return { ...thread, ...next };
    });
    return changed ? { ...model, threads } : model;
  };
  const withoutDeferred = (thread: OrchestrationThread, messageId: string) =>
    (thread.deferredTurnStarts ?? []).filter(
      (deferred) => deferred.message.messageId !== messageId,
    );

  switch (event.type) {
    case "thread.turn-start-deferred": {
      const { threadId, ...deferred } = event.payload;
      return update(threadId, (thread) => ({
        deferredTurnStarts: [...(thread.deferredTurnStarts ?? []), deferred],
      }));
    }
    case "thread.turn-start-requested":
      return update(event.payload.threadId, (thread) => ({
        pendingTurnStart: {
          messageId: event.payload.messageId,
          requestedAt: event.payload.createdAt,
        },
        deferredTurnStarts: withoutDeferred(thread, event.payload.messageId),
      }));
    case "thread.deferred-turn-start-dropped":
      return update(event.payload.threadId, (thread) => ({
        deferredTurnStarts: withoutDeferred(thread, event.payload.messageId),
      }));
    case "thread.session-set":
      return update(event.payload.threadId, (thread) => {
        const pending = thread.pendingTurnStart ?? null;
        if (pending === null) return null;
        const { status, activeTurnId, updatedAt } = event.payload.session;
        // A turn took the start up, the session ended, or the session went
        // idle after the start was asked for. A `ready` stamped before the
        // request is the previous turn ending late and settles nothing.
        const settled =
          (status === "running" && activeTurnId !== null) ||
          status === "stopped" ||
          status === "interrupted" ||
          status === "error" ||
          ((status === "ready" || status === "idle") &&
            compareDateTimeStrings(updatedAt, pending.requestedAt) >= 0);
        return settled ? { pendingTurnStart: null } : null;
      });
    case "thread.activity-appended":
      return update(event.payload.threadId, (thread) => {
        const pending = thread.pendingTurnStart ?? null;
        const { kind, payload } = event.payload.activity;
        // The provider reactor reports a start that never became a turn, and
        // a finished compaction, against the start's message id.
        return pending !== null &&
          (kind === "provider.turn.start.failed" || kind === "context-compaction") &&
          activityRequestId(payload) === pending.messageId
          ? { pendingTurnStart: null }
          : null;
      });
    case "thread.archived":
    case "thread.deleted":
      return update(event.payload.threadId, () => ({ deferredTurnStarts: [] }));
    default:
      return model;
  }
}

/**
 * For a start that asks to queue: the event that holds it, or null when the
 * thread is free and the start should run now.
 */
export const deferTurnStartIfBusy = Effect.fn("deferTurnStartIfBusy")(function* (input: {
  readonly command: TurnStartCommand;
  readonly thread: OrchestrationThread;
  readonly now: string;
  readonly eventBase: EventBase;
}) {
  const { command, thread, now } = input;
  if (!turnStartMustWait(thread)) return null;
  const event: PlannedEvent = {
    ...(yield* input.eventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: now,
      commandId: command.commandId,
    })),
    type: "thread.turn-start-deferred",
    payload: {
      threadId: command.threadId,
      commandId: command.commandId,
      message: command.message,
      ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
      ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
      ...(command.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: command.sourceProposedPlan }
        : {}),
      ...(command.issuer !== undefined ? { issuer: command.issuer } : {}),
      ...(command.environment !== undefined ? { hasEnvironment: true as const } : {}),
      deferredAt: now,
    },
  };
  return event;
});

const dropEvents = Effect.fn("dropDeferredTurnStarts")(function* (input: {
  readonly threadId: ThreadId;
  readonly deferred: ReadonlyArray<OrchestrationDeferredTurnStart>;
  readonly reason: DeferredTurnStartDropReason;
  readonly now: string;
  readonly eventBase: EventBase;
}) {
  const events: PlannedEvent[] = [];
  for (const deferred of input.deferred) {
    events.push({
      // Under the deferred start's own command id, so its sender can match
      // the drop to its request.
      ...(yield* input.eventBase({
        aggregateKind: "thread",
        aggregateId: input.threadId,
        occurredAt: input.now,
        commandId: deferred.commandId,
      })),
      type: "thread.deferred-turn-start-dropped",
      payload: {
        threadId: input.threadId,
        messageId: deferred.message.messageId,
        reason: input.reason,
        droppedAt: input.now,
      },
    });
  }
  return events;
});

/**
 * Starts the oldest deferred start on a free thread, as the `thread.turn.start`
 * it was sent as. One that the decider now refuses, or whose environment the
 * engine no longer holds, is dropped, and the next is tried, so a dropped start
 * never leaves the rest waiting on a free thread.
 */
export const releaseDeferredTurnStart = Effect.fn("releaseDeferredTurnStart")(function* (input: {
  readonly readModel: OrchestrationReadModel;
  readonly thread: OrchestrationThread;
  readonly now: string;
  readonly decide: Decide;
  readonly eventBase: EventBase;
}) {
  const { thread, now } = input;
  // Signed-off exception to "orchestration stays pure": this asks the engine's
  // memory whether it still holds the environment. The environment can hold
  // secrets, so it can never be stored on an event or in a table, and memory is
  // the only place it can be. So the same command and read model decide
  // differently after a restart: the start is dropped rather than run without
  // its environment.
  const { hasDeferredTurnEnvironment } = yield* DeciderContext;
  const dropped: PlannedEvent[] = [];
  for (const deferred of thread.deferredTurnStarts ?? []) {
    if (deferred.hasEnvironment === true && !hasDeferredTurnEnvironment(deferred.commandId)) {
      dropped.push(
        ...(yield* dropEvents({
          threadId: thread.id,
          deferred: [deferred],
          reason: "environment-lost",
          now,
          eventBase: input.eventBase,
        })),
      );
      continue;
    }
    const command: TurnStartCommand = {
      type: "thread.turn.start",
      commandId: deferred.commandId,
      threadId: thread.id,
      message: deferred.message,
      ...(deferred.modelSelection !== undefined ? { modelSelection: deferred.modelSelection } : {}),
      ...(deferred.titleSeed !== undefined ? { titleSeed: deferred.titleSeed } : {}),
      ...(deferred.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: deferred.sourceProposedPlan }
        : {}),
      ...(deferred.issuer !== undefined ? { issuer: deferred.issuer } : {}),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: now,
    };
    const started = yield* input.decide(command, input.readModel).pipe(
      Effect.map((events) => (Array.isArray(events) ? events : [events])),
      Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(null)),
    );
    if (started !== null) return [...dropped, ...started];
    dropped.push(
      ...(yield* dropEvents({
        threadId: thread.id,
        deferred: [deferred],
        reason: "turn-start-refused",
        now,
        eventBase: input.eventBase,
      })),
    );
  }
  return dropped;
});

function dropReasonFor(
  command: OrchestrationCommand,
  before: OrchestrationThread,
  planned: ReadonlyArray<PlannedEvent>,
): DeferredTurnStartDropReason | null {
  switch (command.type) {
    case "thread.turn.interrupt":
      return "turn-interrupt-requested";
    case "thread.session.stop":
      return planned.some((event) => event.type === "thread.session-stop-requested")
        ? "session-stop-requested"
        : null;
    case "thread.archive":
      return "thread-archived";
    case "thread.delete":
      return "thread-deleted";
  }
  for (const plannedEvent of planned) {
    if (plannedEvent.type === "thread.session-set") {
      const event = plannedEvent as PlannedEventOf<"thread.session-set">;
      switch (event.payload.session.status) {
        case "stopped":
          return "session-stopped";
        case "interrupted":
          return "session-interrupted";
        case "error":
          return "session-error";
      }
    }
    if (plannedEvent.type === "thread.activity-appended" && before.pendingTurnStart != null) {
      const { activity } = (plannedEvent as PlannedEventOf<"thread.activity-appended">).payload;
      if (
        activity.kind === "provider.turn.start.failed" &&
        activityRequestId(activity.payload) === before.pendingTurnStart.messageId
      ) {
        return "turn-start-failed";
      }
    }
  }
  return null;
}

/**
 * Runs after the decider for every command. Leaves the planned events alone
 * unless the command's thread holds deferred starts; then it adds the events
 * that drop them or start the oldest one.
 */
export const followDeferredTurnStarts = Effect.fn("followDeferredTurnStarts")(function* (input: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly planned: ReadonlyArray<PlannedEvent>;
  readonly now: string;
  readonly decide: Decide;
  readonly project: Project;
  readonly eventBase: EventBase;
}) {
  const { command, planned, now } = input;
  // A turn start decides for itself whether to wait; the release command
  // starts one on purpose.
  if (command.type === "thread.turn.start" || command.type === "thread.deferred-turn-start.release")
    return null;
  const threadId = "threadId" in command ? command.threadId : undefined;
  const before =
    threadId === undefined
      ? undefined
      : input.readModel.threads.find((thread) => thread.id === threadId);
  const deferred = before?.deferredTurnStarts ?? [];
  if (before === undefined || deferred.length === 0) return null;

  const reason = dropReasonFor(command, before, planned);
  if (reason !== null) {
    return yield* dropEvents({
      threadId: before.id,
      deferred,
      reason,
      now,
      eventBase: input.eventBase,
    });
  }
  if (!threadIsFree(before)) {
    let next = input.readModel;
    for (const event of planned) {
      next = yield* input
        .project(next, { ...event, sequence: next.snapshotSequence + 1 } as OrchestrationEvent)
        .pipe(Effect.orDie);
    }
    const after = next.threads.find((thread) => thread.id === before.id);
    if (after !== undefined && threadIsFree(after)) {
      return yield* releaseDeferredTurnStart({
        readModel: next,
        thread: after,
        now,
        decide: input.decide,
        eventBase: input.eventBase,
      });
    }
  }
  return null;
});
