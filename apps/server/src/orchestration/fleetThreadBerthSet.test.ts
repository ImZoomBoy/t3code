import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FleetRole,
  type OrchestrationCommand,
  WireOrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
 * The fleet sets the role and repository on a thread it already owns.
 *
 * Threads the fleet created before it sent `fleetRole` carry none, so the
 * sidebar cannot place them and `thread.read-only.clear` refuses them.
 * `thread.fleet-berth.set` repairs them. These tests run the real engine over
 * a SQLite file, and a restart builds the engine again over that file, so the
 * thread is read back from the persisted projection.
 */
const NOW = "2026-01-01T00:00:00.000Z";
const decodeWire = Schema.decodeUnknownEffect(WireOrchestrationCommand);
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
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-berth-set-test-" })),
    Layer.provide(NodeServices.layer),
  );

type Engine = OrchestrationEngineService | ProjectionSnapshotQuery;

/** What `normalizeDispatchCommand` needs, as a dispatch entry point has it. */
const normalizerLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-berth-set-normalizer-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

/** One server lifetime over `databasePath`. */
const withEngine = <A, E>(databasePath: string, effect: Effect.Effect<A, E, Engine>) =>
  effect.pipe(Effect.provide(engineLayer(databasePath)));

const dispatch = (command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* engine.dispatch(command);
  });

/** Role and repository in every read model a client or the decider sees the thread through. */
const berthEverywhere = (threadId: ThreadId) =>
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
    return [shell, shellById, detail, command].map((thread) => [
      thread?.fleetRole ?? null,
      thread?.fleetRepo ?? null,
    ]);
  });

const berthed = (role: FleetRole | null, repo: string | null) =>
  Array.from({ length: 4 }, () => [role, repo]);

const readOnlyEverywhere = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const shellById = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
    const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
    const command = (yield* snapshots.getCommandReadModel()).threads.find(
      (thread) => thread.id === threadId,
    );
    return [shellById.readOnly, detail.readOnly, command?.readOnly];
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
  fleet: {
    readonly fleetRole?: FleetRole;
    readonly fleetRepo?: string;
    readonly readOnly?: boolean;
    readonly issuer?: "fleet";
  },
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
    ...fleet,
    createdAt: NOW,
  });

/** A fleet thread from before the fleet sent `fleetRole`: fleet-owned, read-only, no role. */
const createLegacyFleetThread = (threadId: ThreadId) =>
  createThread(threadId, { readOnly: true, issuer: "fleet" });

const setBerth = (
  commandId: string,
  threadId: ThreadId,
  fleetRole: FleetRole,
  fleetRepo: string,
  issuer: "fleet" | null = "fleet",
) =>
  dispatch({
    type: "thread.fleet-berth.set",
    commandId: CommandId.make(commandId),
    threadId,
    fleetRole,
    fleetRepo,
    ...(issuer !== null ? { issuer } : {}),
    createdAt: NOW,
  });

const clearReadOnly = (commandId: string, threadId: ThreadId) =>
  dispatch({
    type: "thread.read-only.clear",
    commandId: CommandId.make(commandId),
    threadId,
    issuer: "fleet",
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
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fleet-berth-set-" });
  return path.join(directory, "state.sqlite");
});

it.layer(NodeServices.layer)("thread.fleet-berth.set", (it) => {
  it.effect("gives a legacy fleet thread a second mate berth, so the fleet can unlock it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-legacy");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createLegacyFleetThread(threadId);
          expect(yield* errorMessage(clearReadOnly("clear-before", threadId))).toMatch(
            /is not a fleet-owned second mate thread/,
          );

          yield* setBerth("berth-second-mate", threadId, "second-mate", "t3code");
          yield* clearReadOnly("clear-after", threadId);

          expect(yield* berthEverywhere(threadId)).toEqual(berthed("second-mate", "t3code"));
          expect(yield* readOnlyEverywhere(threadId)).toEqual([false, false, false]);
        }),
      );
    }),
  );

  it.effect("sets role and repository on the thread and its shell row, across a restart", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath;
      const threadId = ThreadId.make("thread-legacy");

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createLegacyFleetThread(threadId);
          expect(yield* berthEverywhere(threadId)).toEqual(berthed(null, null));

          yield* setBerth("berth-worker", threadId, "worker", "t3code");

          expect(yield* berthEverywhere(threadId)).toEqual(berthed("worker", "t3code"));
        }),
      );

      yield* withEngine(
        databasePath,
        Effect.gen(function* () {
          expect(yield* berthEverywhere(threadId)).toEqual(berthed("worker", "t3code"));
          // Read-only is untouched: the berth is a label, not a permission.
          expect(yield* readOnlyEverywhere(threadId)).toEqual([true, true, true]);
        }),
      );
    }),
  );

  it.effect("moves a fleet thread from one berth to another", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-worker");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createThread(threadId, {
            fleetRole: "worker",
            fleetRepo: "firstmate",
            issuer: "fleet",
          });

          yield* setBerth("berth-second-mate", threadId, "second-mate", "t3code");

          expect(yield* berthEverywhere(threadId)).toEqual(berthed("second-mate", "t3code"));
        }),
      );
    }),
  );

  it.effect("accepts the berth a thread already has and changes nothing", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-second-mate");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createThread(threadId, {
            fleetRole: "second-mate",
            fleetRepo: "t3code",
            issuer: "fleet",
          });
          const updatedAtBefore = yield* shellUpdatedAt(threadId);

          yield* setBerth("berth-same", threadId, "second-mate", "t3code");

          expect(yield* berthEverywhere(threadId)).toEqual(berthed("second-mate", "t3code"));
          expect(yield* shellUpdatedAt(threadId)).toBe(updatedAtBefore);
        }),
      );
    }),
  );

  it.effect.each([
    [
      "a first-mate role",
      { readOnly: true, issuer: "fleet" },
      "first-mate",
      /First Mate thread is only made by thread.create/,
    ],
    [
      "a thread the fleet does not own",
      { readOnly: true },
      "second-mate",
      /is not fleet-owned, so its berth stays as it is/,
    ],
    [
      "the First Mate thread",
      { fleetRole: "first-mate", issuer: "fleet" },
      "second-mate",
      /is the First Mate thread, so its berth stays as it is/,
    ],
  ] as const)("refuses %s and leaves the thread as it was", ([, fleet, role, refusal]) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-refused");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createThread(threadId, fleet);
          const before = yield* berthEverywhere(threadId);

          expect(yield* errorMessage(setBerth("berth-refused", threadId, role, "t3code"))).toMatch(
            refusal,
          );
          expect(yield* berthEverywhere(threadId)).toEqual(before);
        }),
      );
    }),
  );

  it.effect("refuses a blank repository", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-legacy");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createLegacyFleetThread(threadId);

          expect(
            yield* errorMessage(setBerth("berth-blank", threadId, "second-mate", "  ")),
          ).toMatch(/needs a repository/);
          expect(yield* berthEverywhere(threadId)).toEqual(berthed(null, null));
        }),
      );
    }),
  );

  it.effect("refuses a berth that does not come from the fleet", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-legacy");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createLegacyFleetThread(threadId);

          expect(
            yield* errorMessage(
              setBerth("berth-from-client", threadId, "second-mate", "t3code", null),
            ),
          ).toMatch(/Only the fleet may set the berth of thread/);
          expect(yield* berthEverywhere(threadId)).toEqual(berthed(null, null));
        }),
      );
    }),
  );

  it.effect("refuses a raw client payload that spells issuer fleet", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-legacy");
      // What an ordinary client can put on the wire. The wire shape has no
      // `issuer`, so decoding drops it, and the entry point stamps nothing
      // for a client session.
      const decoded = yield* decodeWire({
        type: "thread.fleet-berth.set",
        commandId: "berth-forged",
        threadId,
        fleetRole: "second-mate",
        fleetRepo: "t3code",
        createdAt: NOW,
        issuer: "fleet",
      });
      expect(decoded).not.toHaveProperty("issuer");
      const command = yield* normalizeDispatchCommand(decoded, "client").pipe(
        Effect.provide(normalizerLayer),
      );
      expect(command).not.toHaveProperty("issuer");

      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createLegacyFleetThread(threadId);

          expect(yield* errorMessage(dispatch(command))).toMatch(
            /Only the fleet may set the berth of thread/,
          );
          expect(yield* berthEverywhere(threadId)).toEqual(berthed(null, null));
        }),
      );
    }),
  );

  it.effect("refuses an archived fleet thread and leaves it as it was", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-legacy");
      yield* withEngine(
        yield* makeDatabasePath,
        Effect.gen(function* () {
          yield* createProject;
          yield* createLegacyFleetThread(threadId);
          yield* dispatch({
            type: "thread.archive",
            commandId: CommandId.make("archive"),
            threadId,
          });

          expect(
            yield* errorMessage(setBerth("berth-archived", threadId, "second-mate", "t3code")),
          ).toMatch(/is already archived/);
          const snapshots = yield* ProjectionSnapshotQuery;
          const shell = (yield* snapshots.getArchivedShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          );
          const command = (yield* snapshots.getCommandReadModel()).threads.find(
            (thread) => thread.id === threadId,
          );
          expect([shell?.fleetRole ?? null, command?.fleetRole ?? null]).toEqual([null, null]);
        }),
      );
    }),
  );
});

it.layer(normalizerLayer)("thread.fleet-berth.set at the dispatch entry point", (it) => {
  const wire = {
    type: "thread.fleet-berth.set",
    commandId: CommandId.make("berth"),
    threadId: ThreadId.make("thread-legacy"),
    fleetRole: "second-mate",
    fleetRepo: "t3code",
    createdAt: NOW,
  } as const;

  it.effect("decodes the wire shape the fleet sends", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWire(wire);
      expect(decoded).toEqual(wire);
    }),
  );

  it.effect("stamps a berth the fleet sent", () =>
    Effect.gen(function* () {
      const command = yield* normalizeDispatchCommand(wire, "fleet");
      expect(command).toMatchObject({ type: "thread.fleet-berth.set", issuer: "fleet" });
    }),
  );

  it.effect("leaves a berth a client sent unstamped, so the decider refuses it", () =>
    Effect.gen(function* () {
      const command = yield* normalizeDispatchCommand(wire, "client");
      expect(command).not.toHaveProperty("issuer");
    }),
  );
});
