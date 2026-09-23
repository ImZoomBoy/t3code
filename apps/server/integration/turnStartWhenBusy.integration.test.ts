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
  type TurnStartWhenBusy,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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

// Every stamp here is the real clock. Whether a user message has been adopted
// by a turn is judged by comparing its time with the turn's, so the fixture
// events have to share the clock the server stamps a waiting turn start with.
const liveNow = () => DateTime.formatIso(DateTime.nowUnsafe());

const withHarness = <A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: PROVIDER }),
    use,
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

/** Starts the person's turn and holds it running until the returned deferred completes. */
const startHeldTurn = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    yield* harness.adapterHarness!.queueTurnResponseForNextSession(
      turnResponse("person reply", release),
    );
    yield* startTurn(harness, { id: "person", text: "person message" });
    yield* harness.waitForThread(THREAD_ID, (thread) => thread.session?.status === "running");
    return release;
  });

const waitUntil = <E>(check: Effect.Effect<boolean, E>, description: string) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 20_000;
    while (!(yield* check)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error(`timed out waiting until ${description}`));
      }
      yield* Effect.sleep(10);
    }
  });

const sendCount = (harness: OrchestrationIntegrationHarness) =>
  harness.adapterHarness!.getTurnInputs(THREAD_ID).length +
  harness.adapterHarness!.getSteers(THREAD_ID).length;

/** Waits until the adapter has seen `count` sends, as new turns or as steers. */
const waitForSends = (harness: OrchestrationIntegrationHarness, count: number) =>
  waitUntil(
    Effect.sync(() => sendCount(harness) >= count),
    `the adapter saw ${count} sends`,
  );

/**
 * Waits until the server has acted on a turn start that arrived while the
 * person's turn runs: it either holds it or has sent it to the adapter.
 * Releasing the person's turn before that would let an unqueued start miss
 * the running turn by luck rather than by design.
 */
const waitForHandledWhileBusy = (
  harness: OrchestrationIntegrationHarness,
  commandId: string,
  sendsBefore: number,
) =>
  waitUntil(
    eventTypesFor(harness, commandId).pipe(
      Effect.map(
        (types) => types.includes("thread.turn-start-deferred") || sendCount(harness) > sendsBefore,
      ),
    ),
    `the server handled ${commandId}`,
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
        yield* startTurn(harness, { id: "wake", text: "wake message", whenBusy: "queue" });
        yield* waitForHandledWhileBusy(harness, "cmd-wake", 1);
        yield* Deferred.succeed(release, undefined);
        yield* waitForSends(harness, 2);

        const adapter = harness.adapterHarness!;
        assert.deepEqual(inputsOf(adapter.getSteers(THREAD_ID)), []);
        assert.deepEqual(inputsOf(adapter.getTurnInputs(THREAD_ID)), [
          "person message",
          "wake message",
        ]);
        yield* harness.waitForThread(
          THREAD_ID,
          (thread) => thread.session?.status === "ready" && thread.latestTurn?.turnId === "turn-2",
        );
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

      yield* startTurn(harness, { id: "first", text: "first queued", whenBusy: "queue" });
      yield* startTurn(harness, { id: "second", text: "second queued", whenBusy: "queue" });
      yield* waitForHandledWhileBusy(harness, "cmd-first", 1);
      yield* waitForHandledWhileBusy(harness, "cmd-second", 1);
      yield* Deferred.succeed(release, undefined);
      yield* waitForSends(harness, 3);

      const adapter = harness.adapterHarness!;
      assert.deepEqual(inputsOf(adapter.getSteers(THREAD_ID)), []);
      assert.deepEqual(inputsOf(adapter.getTurnInputs(THREAD_ID)), [
        "person message",
        "first queued",
        "second queued",
      ]);
      yield* harness.waitForThread(
        THREAD_ID,
        (thread) => thread.session?.status === "ready" && thread.latestTurn?.turnId === "turn-3",
      );
    }),
  ),
);

it.live("a turn start that asks to queue runs at once on an idle thread", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse("wake reply"));

      yield* startTurn(harness, { id: "wake", text: "wake message", whenBusy: "queue" });
      yield* waitForSends(harness, 1);

      assert.deepEqual(inputsOf(harness.adapterHarness!.getTurnInputs(THREAD_ID)), [
        "wake message",
      ]);
      assert.deepEqual(yield* eventTypesFor(harness, "cmd-wake"), [
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  ),
);

it.live("a turn start that does not ask to wait still steers into the running turn", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const release = yield* startHeldTurn(harness);

      yield* startTurn(harness, { id: "steer", text: "steer message" });
      yield* waitForSends(harness, 2);
      yield* Deferred.succeed(release, undefined);
      yield* harness.waitForThread(THREAD_ID, (thread) => thread.session?.status === "ready");

      const adapter = harness.adapterHarness!;
      assert.deepEqual(inputsOf(adapter.getTurnInputs(THREAD_ID)), ["person message"]);
      assert.deepEqual(adapter.getSteers(THREAD_ID), [
        { turnId: TurnId.make("turn-1"), input: "steer message" },
      ]);
    }),
  ),
);
