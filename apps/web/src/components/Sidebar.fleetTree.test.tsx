import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  type ProjectIconColor,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { resetUiStateForTests } from "../uiStateStore";
import { useFleetTreeRows } from "./Sidebar";
import { buildFleetTree, type FleetParked } from "./sidebar/fleetSidebar.logic";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);
const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);

const thread = (
  id: string,
  projectId: string,
  fleetRole: "second-mate" | "worker",
  fleetRepo: string,
  createdAt: string,
): EnvironmentThreadShell => ({
  ...decodeThread({
    id,
    projectId,
    title: id,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    fleetRole,
    fleetRepo,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }),
  environmentId: ENVIRONMENT,
});

const project = (id: string, color: ProjectIconColor): EnvironmentProject => ({
  ...decodeProject({
    id,
    title: id,
    workspaceRoot: `C:\\work\\${id}`,
    defaultModelSelection: null,
    projectIcon: { kind: "lucide", name: "folder-code", color },
    scripts: [],
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
  }),
  environmentId: ENVIRONMENT,
});

// Two second mates, as in the report: firstmate with many workers, sheppi with one.
const THREADS = [
  thread("firstmate-mate", "firstmate", "second-mate", "firstmate", "2026-09-25T10:00:00.000Z"),
  thread("firstmate-worker-1", "firstmate", "worker", "firstmate", "2026-09-25T10:01:00.000Z"),
  thread("firstmate-worker-2", "firstmate", "worker", "firstmate", "2026-09-25T10:02:00.000Z"),
  thread("sheppi-mate", "sheppi", "second-mate", "sheppi", "2026-09-25T10:03:00.000Z"),
  thread("sheppi-worker", "sheppi", "worker", "sheppi", "2026-09-25T10:04:00.000Z"),
];
const BRANCHES = buildFleetTree(THREADS, { parkedState: () => null }).branches;
const NOT_PARKED: ReadonlyMap<EnvironmentThreadShell, FleetParked> = new Map();

const projectsWithSheppi = (color: ProjectIconColor) =>
  new Map(
    [project("firstmate", "violet"), project("sheppi", color)].map((entry) => [
      `${entry.environmentId}:${entry.id}`,
      entry,
    ]),
  );

type FleetTreeRows = ReturnType<typeof useFleetTreeRows>;
let rows: FleetTreeRows = [];
let renderer: ReactTestRenderer | null = null;

function FleetTree(props: { readonly projectByKey: ReadonlyMap<string, EnvironmentProject> }) {
  const next = useFleetTreeRows(BRANCHES, NOT_PARKED, props.projectByKey);
  useEffect(() => {
    rows = next;
  }, [next]);
  return null;
}

function mountSidebar(projectByKey: ReadonlyMap<string, EnvironmentProject>) {
  act(() => {
    renderer = create(<FleetTree projectByKey={projectByKey} />);
  });
}

function unmountSidebar() {
  act(() => renderer?.unmount());
  renderer = null;
}

const shownIds = () => rows.map((row) => row.thread.id);
const rowFor = (id: string) => rows.find((row) => row.thread.id === id);
const iconColorOf = (id: string) => {
  const theme = rowFor(id)?.placement.theme;
  return theme?.kind === "project" ? theme.project?.projectIcon : undefined;
};

beforeEach(resetUiStateForTests);
afterEach(unmountSidebar);

describe("sidebar fleet tree", () => {
  it("keeps a folded second mate folded through Settings and a project icon change", () => {
    mountSidebar(projectsWithSheppi("green"));
    act(() => rowFor("firstmate-mate")?.placement.fold?.onToggle());
    expect(shownIds()).toEqual(["firstmate-mate", "sheppi-mate", "sheppi-worker"]);

    // Settings unmounts the sidebar. The user changes sheppi's icon colour there, then goes Back.
    unmountSidebar();
    mountSidebar(projectsWithSheppi("blue"));

    expect(shownIds()).toEqual(["firstmate-mate", "sheppi-mate", "sheppi-worker"]);
    expect(rowFor("firstmate-mate")?.placement.fold?.expanded).toBe(false);
  });

  it("gives a second mate and its workers the project's new colour at once", () => {
    mountSidebar(projectsWithSheppi("green"));
    expect(iconColorOf("sheppi-mate")).toMatchObject({ color: "green" });

    // The sidebar stays open while another client changes the icon.
    act(() => renderer?.update(<FleetTree projectByKey={projectsWithSheppi("blue")} />));

    expect(iconColorOf("sheppi-mate")).toMatchObject({ color: "blue" });
    expect(iconColorOf("sheppi-worker")).toMatchObject({ color: "blue" });
  });
});
