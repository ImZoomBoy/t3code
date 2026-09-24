import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  defaultInstanceIdForDriver,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type TurnStartWhenBusy,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import type { TestTurnInput, TestTurnResponse } from "./TestProviderAdapter.integration.ts";

// The adapter that steers a send into a running turn is Claude's, so the
// fixture provider stands in for it. See `TestTurnResponse.holdCompletion`.
const PROVIDER = ProviderDriverKind.make("claudeAgent");
const PROJECT_ID = ProjectId.make("project-turn-start-when-busy");
const THREAD_ID = ThreadId.make("thread-turn-start-when-busy");

// Every stamp here is the real clock. Whether a session going idle settles the
// turn start the thread waits on is judged by comparing their times, so the
// fixture events have to share the clock the server stamps a turn start with.
const liveNow = () => DateTime.formatIso(DateTime.nowUnsafe());

const withHarness = <A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: PROVIDER }),
    (harness) => Effect.scoped(use(harness)),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = liveNow();
    const modelSelection = {
      instanceId: defaultInstanceIdForDriver(PROVIDER),
      model: DEFAULT_MODEL_BY_PROVIDER[PROVIDER] ?? DEFAULT_MODEL,
    };
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Turn start when busy",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: modelSelection,
      createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Turn start when busy",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

/** A turn that answers `reply`, dated when the adapter runs it. */
const turnResponse = (
  reply: string,
  holdCompletion?: Deferred.Deferred<void>,
): TestTurnResponse => ({
  get events() {
    const at = liveNow();
    const base = { provider: PROVIDER, createdAt: at, threadId: THREAD_ID, turnId: "fixture" };
    return [
      { ...base, type: "turn.started", eventId: EventId.make(`${reply}-started`) },
      { ...base, type: "message.delta", eventId: EventId.make(`${reply}-delta`), delta: reply },
      {
        ...base,
        type: "turn.completed",
        eventId: EventId.make(`${reply}-completed`),
        status: "completed",
      },
    ];
  },
  ...(holdCompletion !== undefined ? { holdCompletion } : {}),
});

const startTurn = (
  harness: OrchestrationIntegrationHarness,
  input: { readonly id: string; readonly text: string; readonly whenBusy?: TurnStartWhenBusy },
) =>
  harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-${input.id}`),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make(`msg-${input.id}`),
      role: "user",
      text: input.text,
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    ...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
    createdAt: liveNow(),
  });

/**
 * Starts listening for `count` domain events that match, and returns a fiber
 * that completes when they have all arrived. Listen before the action that
 * causes them, so none is missed.
 */
const watchEvents = (
  harness: OrchestrationIntegrationHarness,
  predicate: (event: OrchestrationEvent) => boolean,
  count = 1,
) =>
  Effect.gen(function* () {
    const events = yield* harness.engine.subscribeDomainEvents;
    return yield* events.pipe(
      Stream.filter(predicate),
      Stream.take(count),
      Stream.runCollect,
      Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
      Effect.forkScoped,
    );
  });

const isSessionStatus =
  (status: "running" | "ready") =>
  (event: OrchestrationEvent): boolean =>
    event.type === "thread.session-set" &&
    event.payload.threadId === THREAD_ID &&
    event.payload.session.status === status;

const isForCommand =
  (type: OrchestrationEvent["type"], commandId: string) =>
  (event: OrchestrationEvent): boolean =>
    event.type === type && event.commandId === commandId;

/** Starts the person's turn and holds it running until the returned deferred completes. */
const startHeldTurn = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    yield* harness.adapterHarness!.queueTurnResponseForNextSession(
      turnResponse("person reply", release),
    );
    const running = yield* watchEvents(harness, isSessionStatus("running"));
    yield* startTurn(harness, { id: "person", text: "person message" });
    yield* Fiber.join(running);
    return release;
  });

/**
 * Waits until the server has acted on a turn start that arrived while the
 * person's turn runs: it either held it or sent it to the adapter. Releasing
 * the person's turn before that would let an unqueued start miss the running
 * turn by luck rather than by design.
 */
const awaitHandledWhileBusy = (
  harness: OrchestrationIntegrationHarness,
  held: Fiber.Fiber<ReadonlyArray<OrchestrationEvent>>,
  sendsIfSteered: number,
) =>
  Effect.raceFirst(
    Fiber.join(held).pipe(Effect.asVoid),
    harness.adapterHarness!.awaitSends(THREAD_ID, sendsIfSteered),
  );

const inputsOf = (inputs: ReadonlyArray<TestTurnInput>) => inputs.map((entry) => entry.input);

const eventTypesFor = (harness: OrchestrationIntegrationHarness, commandId: string) =>
  Stream.runCollect(harness.engine.readEvents(0)).pipe(
    Effect.map((events) =>
      Array.from(events)
        .filter((event) => event.commandId === commandId)
        .map((event) => event.type),
    ),
  );

it.live(
  "a turn start that asks to queue waits for the running turn instead of steering into it",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);
        const release = yield* startHeldTurn(harness);
        yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, turnResponse("wake reply"));

        // The thread was idle when the supervisor looked. The person started a
        // turn since, and now the wake arrives while that turn runs.
        const held = yield* watchEvents(
          harness,
          isForCommand("thread.turn-start-deferred", "cmd-wake"),
        );
        const bothIdle = yield* watchEvents(harness, isSessionStatus("ready"), 2);
        yield* startTurn(harness, { id: "wake", text: "wake message", whenBusy: "queue" });
        yield* awaitHandledWhileBusy(harness, held, 2);
        yield* Deferred.succeed(release, undefined);
        yield* harness.adapterHarness!.awaitSends(THREAD_ID, 2);

        const adapter = harness.adapterHarness!;
        assert.deepEqual(inputsOf(adapter.getSteers(THREAD_ID)), []);
        assert.deepEqual(inputsOf(adapter.getTurnInputs(THREAD_ID)), [
          "person message",
          "wake message",
        ]);
        yield* Fiber.join(bothIdle);
        // The wake waited as its own record, then started under its own command.
        assert.deepEqual(yield* eventTypesFor(harness, "cmd-wake"), [
          "thread.turn-start-deferred",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
      }),
    ),
);

it.live("turn starts that ask to queue run one at a time, in the order they arrived", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const release = yield* startHeldTurn(harness);
      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, turnResponse("first reply"));
      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, turnResponse("second reply"));

      const firstHeld = yield* watchEvents(
        harness,
        isForCommand("thread.turn-start-deferred", "cmd-first"),
      );
      const secondHeld = yield* watchEvents(
        harness,
        isForCommand("thread.turn-start-deferred", "cmd-second"),
      );
      const allIdle = yield* watchEvents(harness, isSessionStatus("ready"), 3);
      yield* startTurn(harness, { id: "first", text: "first queued", whenBusy: "queue" });
      yield* startTurn(harness, { id: "second", text: "second queued", whenBusy: "queue" });
      yield* awaitHandledWhileBusy(harness, firstHeld, 2);
      yield* awaitHandledWhileBusy(harness, secondHeld, 3);
      yield* Deferred.succeed(release, undefined);
      yield* harness.adapterHarness!.awaitSends(THREAD_ID, 3);

      const adapter = harness.adapterHarness!;
      assert.deepEqual(inputsOf(adapter.getSteers(THREAD_ID)), []);
      assert.deepEqual(inputsOf(adapter.getTurnInputs(THREAD_ID)), [
        "person message",
        "first queued",
        "second queued",
      ]);
      yield* Fiber.join(allIdle);
    }),
  ),
);

it.live("Stop on the running turn drops a held turn start instead of starting it", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const release = yield* startHeldTurn(harness);

      const held = yield* watchEvents(
        harness,
        isForCommand("thread.turn-start-deferred", "cmd-wake"),
      );
      yield* startTurn(harness, { id: "wake", text: "wake message", whenBusy: "queue" });
      yield* Fiber.join(held);

      const dropped = yield* watchEvents(
        harness,
        isForCommand("thread.deferred-turn-start-dropped", "cmd-wake"),
      );
      const idle = yield* watchEvents(harness, isSessionStatus("ready"));
      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-stop"),
        threadId: THREAD_ID,
        createdAt: liveNow(),
      });
      const [drop] = yield* Fiber.join(dropped);
      assert.equal(
        drop?.type === "thread.deferred-turn-start-dropped" ? drop.payload.reason : undefined,
        "turn-interrupt-requested",
      );

      // The fixture adapter ends the turn when released rather than on Stop.
      // The thread going idle afterwards must not start the dropped wake.
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(idle);
      const adapter = harness.adapterHarness!;
      assert.deepEqual(inputsOf(adapter.getTurnInputs(THREAD_ID)), ["person message"]);
      assert.deepEqual(adapter.getSteers(THREAD_ID), []);
      assert.deepEqual(yield* eventTypesFor(harness, "cmd-wake"), [
        "thread.turn-start-deferred",
        "thread.deferred-turn-start-dropped",
      ]);
    }),
  ),
);

it.live("a turn start that asks to queue runs at once on an idle thread", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse("wake reply"));

      const idle = yield* watchEvents(harness, isSessionStatus("ready"));
      yield* startTurn(harness, { id: "wake", text: "wake message", whenBusy: "queue" });
      yield* harness.adapterHarness!.awaitSends(THREAD_ID, 1);

      assert.deepEqual(inputsOf(harness.adapterHarness!.getTurnInputs(THREAD_ID)), [
        "wake message",
      ]);
      assert.deepEqual(yield* eventTypesFor(harness, "cmd-wake"), [
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      yield* Fiber.join(idle);
    }),
  ),
);

it.live("a turn start that does not ask to wait still steers into the running turn", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const release = yield* startHeldTurn(harness);

      const idle = yield* watchEvents(harness, isSessionStatus("ready"));
      yield* startTurn(harness, { id: "steer", text: "steer message" });
      yield* harness.adapterHarness!.awaitSends(THREAD_ID, 2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(idle);

      const adapter = harness.adapterHarness!;
      assert.deepEqual(inputsOf(adapter.getTurnInputs(THREAD_ID)), ["person message"]);
      assert.deepEqual(adapter.getSteers(THREAD_ID), [
        { turnId: TurnId.make("turn-1"), input: "steer message" },
      ]);
    }),
  ),
);
