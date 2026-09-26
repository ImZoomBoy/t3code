import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WireOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

/**
 * A turn start marked `fleetWake` runs as an unmarked one, and its user
 * message carries the mark wherever a client or the server reads it back.
 * These tests run the real engine over a SQLite file, and a restart builds the
 * engine again over that file, so the message is read from the persisted
 * projection.
 */
const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-fleet-wake");
const THREAD_ID = ThreadId.make("thread-fleet-wake");
const decodeWire = Schema.decodeUnknownEffect(WireOrchestrationCommand);
const WAKE_TEXT = "One condition is waiting on this home's trigger log.";

const engineLayer = (databasePath: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(databasePath)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-wake-test-" })),
    Layer.provide(NodeServices.layer),
  );

type Engine = OrchestrationEngineService | ProjectionSnapshotQuery;

/** One server lifetime over `databasePath`. */
const withEngine = <A, E>(databasePath: string, effect: Effect.Effect<A, E, Engine>) =>
  effect.pipe(Effect.provide(engineLayer(databasePath)));

const makeDatabasePath = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fleet-wake-" });
  return path.join(directory, "state.sqlite");
});

const dispatch = (command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* engine.dispatch(command);
  });

const createProjectAndThread = Effect.gen(function* () {
  yield* dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/tmp/project-fleet-wake",
    createdAt: NOW,
  });
  yield* dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-thread"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });
});

const turnStart = (
  messageId: string,
  text: string,
  options: { readonly fleetWake?: boolean; readonly whenBusy?: "queue" } = {},
): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(`start-${messageId}`),
  threadId: THREAD_ID,
  message: { messageId: MessageId.make(messageId), role: "user", text, attachments: [] },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  ...options,
  createdAt: NOW,
});

/**
 * The message as every read a client or the provider reactor makes sees it:
 * the full snapshot, the thread detail a client opens, and the turn start
 * lookup the provider reactor uses. The command model keeps no message bodies. Each entry is `[text, fleetWake]`.
 */
const messageEverywhere = (messageId: string) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const id = MessageId.make(messageId);
    const find = (messages: ReadonlyArray<OrchestrationMessage>) =>
      messages.find((message) => message.id === id);
    const snapshot = find(
      (yield* snapshots.getSnapshot()).threads.find((thread) => thread.id === THREAD_ID)
        ?.messages ?? [],
    );
    const detail = find(
      Option.getOrThrow(yield* snapshots.getThreadDetailById(THREAD_ID)).messages,
    );
    const detailSnapshot = find(
      Option.getOrThrow(yield* snapshots.getThreadDetailSnapshot(THREAD_ID)).thread.messages,
    );
    const turnStartMessage = Option.getOrThrow(
      yield* snapshots.getTurnStartMessage({ threadId: THREAD_ID, messageId: id }),
    ).message;
    return [snapshot, detail, detailSnapshot, turnStartMessage].map((message) => [
      message?.text ?? null,
      message?.fleetWake ?? false,
    ]);
  });

const everywhere = (text: string, fleetWake: boolean) =>
  Array.from({ length: 4 }, () => [text, fleetWake]);

/** The turn start request events, which the provider reactor turns into a provider turn. */
const turnStartRequests = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const events = yield* Stream.runCollect(engine.readEvents(0));
  return Array.from(events).flatMap((event) =>
    event.type === "thread.turn-start-requested" ? [event.payload.messageId] : [],
  );
});

it.layer(NodeServices.layer)("thread.turn.start with fleetWake", (it) => {
  it.effect("keeps the mark on the message across a restart, and still starts the turn", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath;

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          yield* createProjectAndThread;
          yield* dispatch(turnStart("wake-1", WAKE_TEXT, { fleetWake: true }));

          expect(yield* messageEverywhere("wake-1")).toEqual(everywhere(WAKE_TEXT, true));
          expect(yield* turnStartRequests).toEqual([MessageId.make("wake-1")]);
        }),
      );

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          expect(yield* messageEverywhere("wake-1")).toEqual(everywhere(WAKE_TEXT, true));
        }),
      );
    }),
  );

  it.effect("leaves an unmarked message unmarked", () =>
    Effect.gen(function* () {
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProjectAndThread;
          yield* dispatch(turnStart("typed-1", "Please fix the build."));

          expect(yield* messageEverywhere("typed-1")).toEqual(
            everywhere("Please fix the build.", false),
          );
          expect(yield* turnStartRequests).toEqual([MessageId.make("typed-1")]);
        }),
      );
    }),
  );

  it.effect("keeps the mark on a queued wake held across a restart", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath;

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          yield* createProjectAndThread;
          // The first start is still waiting on the provider, so the thread is
          // busy and the wake is held.
          yield* dispatch(turnStart("typed-1", "Please fix the build."));
          yield* dispatch(turnStart("wake-1", WAKE_TEXT, { fleetWake: true, whenBusy: "queue" }));
          expect(yield* turnStartRequests).toEqual([MessageId.make("typed-1")]);
        }),
      );

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          // The turn start the wake waited on died with the process, so the
          // thread is free and the held wake can start.
          yield* dispatch({
            type: "thread.deferred-turn-start.release",
            commandId: CommandId.make("release"),
            threadId: THREAD_ID,
            createdAt: NOW,
          });

          expect(yield* turnStartRequests).toEqual([
            MessageId.make("typed-1"),
            MessageId.make("wake-1"),
          ]);
          expect(yield* messageEverywhere("wake-1")).toEqual(everywhere(WAKE_TEXT, true));
          expect(yield* messageEverywhere("typed-1")).toEqual(
            everywhere("Please fix the build.", false),
          );
        }),
      );
    }),
  );
});

/** What `normalizeDispatchCommand` needs, as a dispatch entry point has it. */
const normalizerLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-wake-normalizer-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(normalizerLayer)("fleetWake at the dispatch entry point", (it) => {
  it.effect("passes the mark a client sends through to the decider", () =>
    Effect.gen(function* () {
      const wire = yield* decodeWire({
        type: "thread.turn.start",
        commandId: "start-wake-1",
        threadId: THREAD_ID,
        message: { messageId: "wake-1", role: "user", text: WAKE_TEXT, attachments: [] },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        fleetWake: true,
        createdAt: NOW,
      });
      const command = yield* normalizeDispatchCommand(wire, "client");
      expect(command.type === "thread.turn.start" && command.fleetWake).toBe(true);
    }),
  );
});
