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
const { server, connection, diffRead, sentinels, viewer, PassThrough } = vi.hoisted(() => {
  const server = {
    pages: new Map<string | null, ServerPage>(),
    reads: [] as Array<string | null>,
  };
  const sentinels: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  return {
    server,
    sentinels,
    viewer: { items: [] as ReadonlyArray<unknown> },
    connection: { atom: null as unknown },
    diffRead: { family: null as unknown },
    PassThrough: ({ children }: { children?: ReactNode }) => children,
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
  Tooltip: PassThrough,
  TooltipTrigger: PassThrough,
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  DropdownMenu: PassThrough,
  DropdownMenuContent: PassThrough,
  DropdownMenuItem: PassThrough,
  DropdownMenuRadioGroup: PassThrough,
  DropdownMenuRadioItem: PassThrough,
  DropdownMenuTrigger: PassThrough,
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

/** One file per page. A page's cursor is the name of its file, the first page's is null. */
interface ServerPage {
  readonly line: string;
  readonly nextCursor: string | null;
}

function patch(line: string): string {
  const path = `${line.split(" ")[0]}.ts`;
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

function answer(cursor: string | null): PullRequestDiffResult {
  const page = server.pages.get(cursor);
  return { patch: patch(page?.line ?? ""), truncated: false, nextCursor: page?.nextCursor ?? null };
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
    [null, { line: "a version 1", nextCursor: "b" }],
    ["b", { line: "b version 1", nextCursor: "c" }],
    ["c", { line: "c version 1", nextCursor: null }],
  ]);
  server.reads = [];
  registry = AtomRegistry.make();
  sentinels.length = 0;
  viewer.items = [];
  const connectionPhase = Atom.make<Phase>("connected").pipe(Atom.keepAlive);
  connection.atom = connectionPhase;
  diffRead.family = Atom.family((key: string) =>
    Atom.make((get): AsyncResult.AsyncResult<PullRequestDiffResult> => {
      if (get(connectionPhase) !== "connected") {
        return AsyncResult.waitingFrom(get.self<AsyncResult.AsyncResult<PullRequestDiffResult>>());
      }
      const cursor = (JSON.parse(key) as { input: { cursor?: string } }).input.cursor ?? null;
      server.reads.push(cursor);
      return AsyncResult.success(answer(cursor));
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

/** The files on screen, in order, as the text of their changed lines. */
function shownLines(): ReadonlyArray<string> {
  const text = JSON.stringify(viewer.items);
  return [...new Set(Array.from(text.matchAll(/[a-z]+ version \d/g), (match) => match[0]))];
}

async function scrollToEnd() {
  await act(async () => sentinels.at(-1)?.([{ isIntersecting: true }]));
}

it.each([
  {
    changed: "the first page, its next page unmoved",
    edits: [[null, { line: "a version 2", nextCursor: "b" }]] as const,
    afterReconnect: ["a version 2", "b version 1", "c version 1"],
    scrollsToEnd: 0,
    atEnd: ["a version 2", "b version 1", "c version 1"],
  },
  {
    changed: "a later page, its next page unmoved",
    edits: [["b", { line: "b version 2", nextCursor: "c" }]] as const,
    afterReconnect: ["a version 1", "b version 2", "c version 1"],
    scrollsToEnd: 0,
    atEnd: ["a version 1", "b version 2", "c version 1"],
  },
  {
    // A file added between the first and second pages moves where the second page starts.
    changed: "the first page, its next page moved",
    edits: [
      [null, { line: "a version 2", nextCursor: "ab" }],
      ["ab", { line: "ab version 1", nextCursor: "b" }],
    ] as const,
    // The pages after it were positions in the old diff, so they go, and come back as the reader
    // reaches the end again.
    afterReconnect: ["a version 2"],
    scrollsToEnd: 3,
    atEnd: ["a version 2", "ab version 1", "b version 1", "c version 1"],
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
  expect(server.reads).toEqual([null, "b", "c"]);

  await setPhase("offline");
  // A turn changes the diff while the client is away.
  for (const [cursor, page] of change.edits) server.pages.set(cursor, page);
  await setPhase("connected");

  // The reconnect re-reads each loaded page once.
  expect(server.reads.slice(3).toSorted()).toEqual([null, "b", "c"].toSorted());
  expect(shownLines()).toEqual(change.afterReconnect);
  for (let scroll = 0; scroll < change.scrollsToEnd; scroll++) await scrollToEnd();
  expect(shownLines()).toEqual(change.atEnd);
});
