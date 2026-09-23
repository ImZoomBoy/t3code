import {
  ClientOrchestrationCommand,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FleetRole,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(
  id: string,
  fleet: { readonly fleetRole?: FleetRole; readonly archivedAt?: string | null } = {},
): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: fleet.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...(fleet.fleetRole !== undefined ? { fleetRole: fleet.fleetRole } : {}),
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "firstmate",
        workspaceRoot: "C:/00_AI_Development/firstmate",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads,
    updatedAt: NOW,
  };
}

function create(
  threadId: string,
  fleet: { readonly fleetRole?: FleetRole | null; readonly fleetRepo?: string | null },
) {
  return {
    type: "thread.create",
    commandId: CommandId.make(`cmd-create-${threadId}`),
    threadId: ThreadId.make(threadId),
    projectId: PROJECT_ID,
    title: "feat/fleet-thread-roles",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    ...fleet,
  } as const;
}

it.layer(NodeServices.layer)("fleet role decider", (it) => {
  it.effect("records a second mate's role and repository on the thread", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel([]);
      const event = yield* decideOrchestrationCommand({
        command: create("thread-2m", { fleetRole: "second-mate", fleetRepo: "t3code" }),
        readModel,
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
      const next = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      const thread = next.threads.find((entry) => entry.id === "thread-2m");
      expect(thread?.fleetRole).toBe("second-mate");
      expect(thread?.fleetRepo).toBe("t3code");
    }),
  );

  it.effect("leaves a thread without a role as it was", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: create("thread-plain", {}),
        readModel: makeReadModel([]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.payload).not.toHaveProperty("fleetRole");
      expect(events[0]?.payload).not.toHaveProperty("fleetRepo");
    }),
  );

  it.effect("drops a repository sent with the First Mate role", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: create("thread-fm", { fleetRole: "first-mate", fleetRepo: "firstmate" }),
        readModel: makeReadModel([]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.payload).toMatchObject({ fleetRole: "first-mate" });
      expect(events[0]?.payload).not.toHaveProperty("fleetRepo");
    }),
  );

  it.effect("refuses a second live First Mate thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: create("thread-fm-2", { fleetRole: "first-mate", fleetRepo: null }),
        readModel: makeReadModel([makeThread("thread-fm-1", { fleetRole: "first-mate" })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("thread-fm-1");
    }),
  );

  it.effect("starts a new First Mate thread once the old one is archived", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: create("thread-fm-2", { fleetRole: "first-mate", fleetRepo: null }),
        readModel: makeReadModel([
          makeThread("thread-fm-1", { fleetRole: "first-mate", archivedAt: NOW }),
        ]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
    }),
  );

  it.effect("still lets workers and second mates run side by side", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: create("thread-w-2", { fleetRole: "worker", fleetRepo: "t3code" }),
        readModel: makeReadModel([
          makeThread("thread-fm", { fleetRole: "first-mate" }),
          makeThread("thread-w-1", { fleetRole: "worker" }),
        ]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
    }),
  );

  it.effect("refuses to bring back an archived First Mate thread while another is live", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-unarchive"),
        threadId: ThreadId.make("thread-fm-old"),
      } as const;
      const old = makeThread("thread-fm-old", { fleetRole: "first-mate", archivedAt: NOW });
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([old, makeThread("thread-fm-new", { fleetRole: "first-mate" })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");

      const event = yield* decideOrchestrationCommand({ command, readModel: makeReadModel([old]) });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.unarchived");
    }),
  );

  it.effect("never settles the First Mate thread automatically", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.auto-settle",
        commandId: CommandId.make("cmd-auto-settle"),
        threadId: ThreadId.make("thread-1"),
        snapshotSequence: 0,
        settledAt: NOW,
      } as const;
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([makeThread("thread-1", { fleetRole: "first-mate" })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");

      const event = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([makeThread("thread-1", { fleetRole: "worker" })]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toContain("thread.settled");
    }),
  );

  it("accepts the fleet fields from a client and refuses an unknown role", () => {
    const decode = Schema.decodeUnknownSync(ClientOrchestrationCommand);
    const decoded = decode(create("thread-wire", { fleetRole: "worker", fleetRepo: "t3code" }));
    expect(decoded).toMatchObject({ fleetRole: "worker", fleetRepo: "t3code" });
    expect(() => decode(create("thread-wire", { fleetRole: "captain" as FleetRole }))).toThrow();
  });
});
