import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  type PullRequestDiffResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

/**
 * A stand-in for the environment's diff reads with the one property this file is about: like
 * every environment query, a read depends on the connection, so a reconnect re-runs each mounted
 * read and leaves an unmounted one holding what it last answered.
 */
const { server, connection, diffRead, sentinels, viewer, Wrapper } = vi.hoisted(() => {
  const server = { pages: new Map<string | null, string>(), reads: [] as Array<string | null> };
  const sentinels: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  return {
    server,
    sentinels,
    viewer: { items: [] as ReadonlyArray<unknown> },
    connection: { atom: null as unknown },
    diffRead: { family: null as unknown },
    Wrapper: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    diff: (target: unknown) =>
      (diffRead.family as (key: string) => unknown)(JSON.stringify(target)),
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./usePullRequestFilesViewed", () => ({
  usePullRequestFilesViewed: () => ({
    setViewed: vi.fn(),
    refresh: vi.fn(),
    enabled: false,
    isViewed: () => false,
    isStale: () => false,
  }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (_key: string, initial: unknown) => [initial, vi.fn()],
}));
vi.mock("../diffs/StyledDiffCodeView", () => ({
  StyledDiffCodeView: ({
    items,
    renderCodeViewFooter,
  }: {
    items: ReadonlyArray<unknown>;
    renderCodeViewFooter: () => ReactNode;
  }) => {
    viewer.items = items;
    return renderCodeViewFooter();
  },
}));
vi.mock("../diffs/useCodeViewFileReveal", () => ({ useCodeViewFileReveal: () => vi.fn() }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: Wrapper,
  TooltipTrigger: Wrapper,
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  DropdownMenu: Wrapper,
  DropdownMenuContent: Wrapper,
  DropdownMenuItem: Wrapper,
  DropdownMenuRadioGroup: Wrapper,
  DropdownMenuRadioItem: Wrapper,
  DropdownMenuTrigger: Wrapper,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import PullRequestCodeTab from "./PullRequestCodeTab";

type Phase = "connected" | "offline";

const environmentId = EnvironmentId.make("env-code-tab");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number: 1,
};
const detail = {
  provider: "github",
  projectId: reference.projectId,
  workspaceRoot: "/workspace",
  repository: reference.repository,
  number: reference.number,
  updatedAt: "2026-09-01T00:00:00Z",
  reviewThreads: [],
  commits: [],
  capabilities: {
    diff: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: { comment: false },
} as unknown as PullRequestDetailView;

/** Three pages of one file each, the way a host pages a diff: by position. */
const NEXT: Record<string, string | null> = { first: "2", "2": "3", "3": null };

function patch(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    `+${line}`,
    "",
  ].join("\n");
}

function page(cursor: string | null): PullRequestDiffResult {
  return {
    patch: server.pages.get(cursor) ?? "",
    truncated: false,
    nextCursor: NEXT[cursor ?? "first"] ?? null,
  };
}

let renderer: ReactTestRenderer | null = null;
let registry = AtomRegistry.make();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        sentinels.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  server.pages = new Map([
    [null, patch("a.ts", "a version 1")],
    ["2", patch("b.ts", "b version 1")],
    ["3", patch("c.ts", "c version 1")],
  ]);
  server.reads = [];
  registry = AtomRegistry.make();
  sentinels.length = 0;
  viewer.items = [];
  const phase = Atom.make<Phase>("connected").pipe(Atom.keepAlive);
  connection.atom = phase;
  diffRead.family = Atom.family((key: string) =>
    Atom.make((get): AsyncResult.AsyncResult<PullRequestDiffResult> => {
      if (get(phase) !== "connected") {
        return AsyncResult.waitingFrom(get.self<AsyncResult.AsyncResult<PullRequestDiffResult>>());
      }
      const cursor = (JSON.parse(key) as { input: { cursor?: string } }).input.cursor ?? null;
      server.reads.push(cursor);
      return AsyncResult.success(page(cursor));
    }).pipe(Atom.keepAlive),
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

async function setPhase(next: Phase) {
  await act(async () => registry.set(connection.atom as Atom.Writable<Phase>, next));
}

/** The files on screen, as the text of their changed lines. */
function shownLines(): ReadonlyArray<string> {
  const text = JSON.stringify(viewer.items);
  return ["a", "b", "c"].flatMap((file) =>
    [1, 2].map((version) => `${file} version ${version}`).filter((line) => text.includes(line)),
  );
}

async function scrollToEnd() {
  await act(async () => sentinels.at(-1)?.([{ isIntersecting: true }]));
}

it.each([
  {
    changed: "the first page",
    cursor: null,
    line: "a version 2",
    afterReconnect: ["a version 2"],
    scrollsToEnd: 2,
  },
  {
    changed: "a later page",
    cursor: "2",
    line: "b version 2",
    afterReconnect: ["a version 1", "b version 2"],
    scrollsToEnd: 1,
  },
])("a reconnect shows $changed as it is now", async (change) => {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <PullRequestCodeTab
          environmentId={environmentId}
          reference={reference}
          detail={detail}
          selectedCommitOid={null}
          onSelectedCommitChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </RegistryContext.Provider>,
      // react-test-renderer has no DOM, so the footer's sentinel ref needs a node to hold.
      { createNodeMock: () => ({}) },
    );
  });
  await scrollToEnd();
  await scrollToEnd();
  expect(shownLines()).toEqual(["a version 1", "b version 1", "c version 1"]);
  // Opening and paging read each page once.
  expect(server.reads).toEqual([null, "2", "3"]);

  await setPhase("offline");
  // A turn changes one page's file while the client is away.
  const file = change.line.slice(0, 1);
  server.pages.set(change.cursor, patch(`${file}.ts`, change.line));
  await setPhase("connected");

  // The reconnect re-reads each loaded page once.
  expect(server.reads.slice(3).toSorted()).toEqual([null, "2", "3"].toSorted());
  // The changed page is shown as it is now. The pages after it were positions in the old diff,
  // so they go, and come back as the reader reaches the end again.
  expect(shownLines()).toEqual(change.afterReconnect);
  for (let scroll = 0; scroll < change.scrollsToEnd; scroll++) await scrollToEnd();
  expect(shownLines()).toEqual(
    ["a version 1", "b version 1", "c version 1"].map((line) =>
      line.startsWith(file) ? change.line : line,
    ),
  );
});
