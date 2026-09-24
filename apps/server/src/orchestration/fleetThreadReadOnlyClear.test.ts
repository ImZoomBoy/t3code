import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FleetRole,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

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
 * The fleet opens a second mate's thread to the person.
 *
 * A second mate's thread is created read-only, so only First Mate prompts it.
 * `thread.read-only.clear` is how First Mate hands it over. These tests run
 * the real engine over a SQLite file, and a restart builds the engine again
 * over that file, so the thread is read back from the persisted projection.
 */
const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-fleet");

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
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-read-only-clear-test-" }),
    ),
    Layer.provide(NodeServices.layer),
  );

type Engine = OrchestrationEngineService | ProjectionSnapshotQuery;

/** One server lifetime over `databasePath`. */
const withEngine = <A, E>(databasePath: string, effect: Effect.Effect<A, E, Engine>) =>
  effect.pipe(Effect.provide(engineLayer(databasePath)));

const dispatch = (command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* engine.dispatch(command);
  });

/** `readOnly` in every read model a client or the decider sees the thread through. */
const readOnlyEverywhere = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const shell = (yield* snapshots.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    const shellById = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
    const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
    const command = (yield* snapshots.getCommandReadModel()).threads.find(
      (thread) => thread.id === threadId,
    );
    return [shell?.readOnly, shellById.readOnly, detail.readOnly, command?.readOnly];
  });

const shellUpdatedAt = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    return Option.getOrThrow(yield* snapshots.getThreadShellById(threadId)).updatedAt;
  });

const createProject = dispatch({
  type: "project.create",
  commandId: CommandId.make("create-project"),
  projectId: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/tmp/project-fleet",
  createdAt: NOW,
});

const createThread = (
  threadId: ThreadId,
  fleet: { readonly fleetRole?: FleetRole; readonly readOnly?: boolean; readonly issuer?: "fleet" },
) =>
  dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${threadId}`),
    threadId,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    ...(fleet.fleetRole !== undefined ? { fleetRole: fleet.fleetRole } : {}),
    ...(fleet.readOnly !== undefined ? { readOnly: fleet.readOnly } : {}),
    ...(fleet.issuer !== undefined ? { issuer: fleet.issuer } : {}),
    createdAt: NOW,
  });

const clear = (commandId: string, threadId: ThreadId, issuer: "fleet" | null = "fleet") =>
  dispatch({
    type: "thread.read-only.clear",
    commandId: CommandId.make(commandId),
    threadId,
    ...(issuer !== null ? { issuer } : {}),
    createdAt: NOW,
  });

const userTurnStart = (commandId: string, threadId: ThreadId) =>
  dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(commandId),
    threadId,
    message: {
      messageId: MessageId.make(`${commandId}-message`),
      role: "user",
      text: "hello",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: NOW,
  });

const errorMessage = <A, E>(effect: Effect.Effect<A, E, Engine>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => String(error)),
  );

const makeDatabasePath = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-read-only-clear-" });
  return path.join(directory, "state.sqlite");
});

it.layer(NodeServices.layer)("thread.read-only.clear", (it) => {
  it.effect("lets the fleet make a read-only second mate thread promptable, across a restart", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath;
      const threadId = ThreadId.make("thread-second-mate");

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createThread(threadId, {
            fleetRole: "second-mate",
            readOnly: true,
            issuer: "fleet",
          });
          expect(yield* errorMessage(userTurnStart("turn-before", threadId))).toMatch(
            /is read-only/,
          );

          yield* clear("clear-second-mate", threadId);

          expect(yield* readOnlyEverywhere(threadId)).toEqual([false, false, false, false]);
          yield* userTurnStart("turn-after", threadId);
        }),
      );

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          expect(yield* readOnlyEverywhere(threadId)).toEqual([false, false, false, false]);
          yield* userTurnStart("turn-after-restart", threadId);
        }),
      );
    }),
  );

  it.effect.each([
    ["a worker thread", { fleetRole: "worker", readOnly: true, issuer: "fleet" }],
    ["the First Mate thread", { fleetRole: "first-mate", readOnly: true, issuer: "fleet" }],
    ["a thread the fleet does not own", { fleetRole: "second-mate", readOnly: true }],
  ] as const)("refuses %s and leaves it read-only", ([, fleet]) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-refused");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createThread(threadId, fleet);

          expect(yield* errorMessage(clear("clear-refused", threadId))).toMatch(
            /is not a fleet-owned second mate thread/,
          );
          expect(yield* readOnlyEverywhere(threadId)).toEqual([true, true, true, true]);
        }),
      );
    }),
  );

  it.effect("refuses a clear that does not come from the fleet", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-second-mate");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createThread(threadId, {
            fleetRole: "second-mate",
            readOnly: true,
            issuer: "fleet",
          });

          expect(yield* errorMessage(clear("clear-from-client", threadId, null))).toMatch(
            /Only the fleet may make thread/,
          );
          expect(yield* readOnlyEverywhere(threadId)).toEqual([true, true, true, true]);
        }),
      );
    }),
  );

  it.effect("accepts a clear on a promptable second mate thread and changes nothing", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-second-mate");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createThread(threadId, { fleetRole: "second-mate", issuer: "fleet" });
          const updatedAtBefore = yield* shellUpdatedAt(threadId);

          yield* clear("clear-promptable", threadId);

          expect(yield* readOnlyEverywhere(threadId)).toEqual([false, false, false, false]);
          expect(yield* shellUpdatedAt(threadId)).toBe(updatedAtBefore);
          yield* userTurnStart("turn-promptable", threadId);
        }),
      );
    }),
  );
});

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-read-only-clear-normalizer-" }),
    WorkspacePaths.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("thread.read-only.clear at the dispatch entry point", (it) => {
  const wire = {
    type: "thread.read-only.clear",
    commandId: CommandId.make("clear"),
    threadId: ThreadId.make("thread-second-mate"),
    createdAt: NOW,
  } as const;

  it.effect("stamps a clear the fleet sent", () =>
    Effect.gen(function* () {
      const command = yield* normalizeDispatchCommand(wire, "fleet");
      expect(command).toMatchObject({ type: "thread.read-only.clear", issuer: "fleet" });
    }),
  );

  it.effect("leaves a clear a client sent unstamped, so the decider refuses it", () =>
    Effect.gen(function* () {
      const command = yield* normalizeDispatchCommand(wire, "client");
      expect(command).not.toHaveProperty("issuer");
    }),
  );
});
