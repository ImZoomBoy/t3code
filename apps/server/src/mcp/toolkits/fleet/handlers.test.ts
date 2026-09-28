import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type IsoDateTime,
  McpCapabilityUnavailableError,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderIntakeLag from "../../../orchestration/ProviderIntakeLag.ts";
import { listThreads, whoami } from "./handlers.ts";

const makeScope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeThreadShell = (
  threadId: string,
  archivedAt: string | null,
): OrchestrationThreadShell => ({
  id: ThreadId.make(threadId),
  projectId: ProjectId.make("project-1"),
  title: `title for ${threadId}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
  updatedAt: "2026-01-02T00:00:00.000Z" as IsoDateTime,
  archivedAt: archivedAt as IsoDateTime | null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const makeSnapshot = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads,
  updatedAt: "2026-01-02T00:00:00.000Z" as IsoDateTime,
});

const makeProjectionLayer = (
  live: ReadonlyArray<OrchestrationThreadShell>,
  archived: ReadonlyArray<OrchestrationThreadShell>,
) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getUserInputActivity: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getImportedAgentSessionSources: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.succeed(makeSnapshot(live)),
    getDeletedWorktreeThreads: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.succeed(makeSnapshot(archived)),
    searchThreads: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getThreadWorkspaceRoot: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    getThreadLifecycleById: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.die("unused"),
    getProjectShells: () => Effect.die("unused"),
  });

it.effect("reports the calling thread's identity from the invocation scope", () => {
  const scope = makeScope(["fleet"]);
  return Effect.gen(function* () {
    const identity = yield* whoami().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    expect(identity).toEqual({
      threadId: scope.threadId,
      environmentId: scope.environmentId,
    });
  });
});

it.effect("refuses the identity verb with the existing capability error", () => {
  const scope = makeScope(["preview"]);
  return Effect.gen(function* () {
    const error = yield* whoami().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "fleet",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      providerSessionId: scope.providerSessionId,
      providerInstanceId: scope.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the fleet capability.");
  });
});

it.effect("lists archived threads alongside live ones and says which is which", () => {
  const scope = makeScope(["fleet"]);
  return Effect.gen(function* () {
    const result = yield* listThreads().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(
        Layer.mergeAll(
          makeProjectionLayer(
            [makeThreadShell("thread-live", null)],
            [makeThreadShell("thread-archived", "2026-01-03T00:00:00.000Z")],
          ),
          ProviderIntakeLag.layer,
        ),
      ),
    );
    expect(result.threads).toEqual([
      {
        threadId: "thread-live",
        projectId: "project-1",
        title: "title for thread-live",
        archived: false,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        threadId: "thread-archived",
        projectId: "project-1",
        title: "title for thread-archived",
        archived: true,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });
});

it.effect("says which threads have provider events not yet applied", () => {
  const scope = makeScope(["fleet"]);
  return Effect.gen(function* () {
    const lag = yield* ProviderIntakeLag.ProviderIntakeLagService;
    lag.recordQueued("thread-busy", Date.parse("2026-01-02T00:30:00.000Z"));
    lag.recordQueued("thread-busy", Date.parse("2026-01-02T00:31:00.000Z"));
    const result = yield* listThreads();
    expect(result.threads.map((thread) => [thread.threadId, thread.providerIntake])).toEqual([
      ["thread-busy", { pendingEvents: 2, oldestPendingAt: "2026-01-02T00:30:00.000Z" }],
      ["thread-quiet", undefined],
    ]);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      Layer.mergeAll(
        makeProjectionLayer(
          [makeThreadShell("thread-busy", null), makeThreadShell("thread-quiet", null)],
          [],
        ),
        ProviderIntakeLag.layer,
      ),
    ),
  );
});

it.effect("refuses listing with the existing capability error", () => {
  const scope = makeScope(["preview"]);
  return Effect.gen(function* () {
    const error = yield* listThreads().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(Layer.mergeAll(makeProjectionLayer([], []), ProviderIntakeLag.layer)),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({ capability: "fleet" });
  });
});
