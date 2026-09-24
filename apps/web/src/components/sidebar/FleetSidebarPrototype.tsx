// PROTOTYPE - throwaway fleet sidebar variants for a design review.
//
// Open the dev app with ?variant=A (or B, C, B-words, B-words-compact) to
// swap the real sidebar's fleet rows for one layout, fed by mock fleet
// threads. Every export is inert unless import.meta.env.DEV, so a production
// build never shows the variants, the mock data, or the floating bar. Nothing
// here sends a command: pins, the First Mate control and lane toggles only
// change local state.

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import type { FleetBranch } from "../Sidebar.logic";

export const FLEET_PROTOTYPE_VARIANTS = [
  { key: "A", name: "One tree" },
  { key: "B", name: "Lanes" },
  { key: "C", name: "Compact rows" },
  { key: "B-words", name: "Lanes, role words" },
  { key: "B-words-compact", name: "Lanes, role words, short workers" },
] as const;
export type FleetPrototypeVariant = (typeof FLEET_PROTOTYPE_VARIANTS)[number]["key"];

const STORAGE_KEY = "t3.prototype.fleetSidebarVariant";

function parseVariant(value: string | null): FleetPrototypeVariant | null {
  return FLEET_PROTOTYPE_VARIANTS.find((variant) => variant.key === value)?.key ?? null;
}

// Read once at module load, before the router rewrites the URL, then kept in
// session storage so the variant survives in-app navigation.
let currentVariant: FleetPrototypeVariant | null = (() => {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const fromUrl = parseVariant(new URLSearchParams(window.location.search).get("variant"));
  if (fromUrl !== null) {
    window.sessionStorage.setItem(STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return parseVariant(window.sessionStorage.getItem(STORAGE_KEY));
})();
const listeners = new Set<() => void>();

function setVariant(next: FleetPrototypeVariant | null) {
  currentVariant = next;
  const url = new URL(window.location.href);
  if (next === null) {
    window.sessionStorage.removeItem(STORAGE_KEY);
    url.searchParams.delete("variant");
  } else {
    window.sessionStorage.setItem(STORAGE_KEY, next);
    url.searchParams.set("variant", next);
  }
  window.history.replaceState(window.history.state, "", url);
  for (const listener of listeners) listener();
}

/** The active prototype variant, or null outside prototype mode. */
export function useFleetPrototypeVariant(): FleetPrototypeVariant | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentVariant,
    () => null,
  );
}

// Whether a mock First Mate is live. Shared, because the sidebar's content
// mounts more than once and the bar must drive every copy.
let firstMateRunning = true;
const runningListeners = new Set<() => void>();

export function setPrototypeFirstMateRunning(next: boolean) {
  firstMateRunning = next;
  for (const listener of runningListeners) listener();
}

export function usePrototypeFirstMateRunning(): boolean {
  return useSyncExternalStore(
    (listener) => {
      runningListeners.add(listener);
      return () => runningListeners.delete(listener);
    },
    () => firstMateRunning,
    () => true,
  );
}

export function isPrototypeThread(thread: { readonly id: string }): boolean {
  return thread.id.startsWith("prototype-");
}

const OPUS = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "contextWindow", value: "1m" }],
};
const SONNET = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5" };
const CODEX = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

interface MockSpec {
  readonly id: string;
  readonly title: string;
  readonly role: "first-mate" | "second-mate" | "worker";
  readonly repo: string | null;
  readonly model: typeof OPUS | typeof SONNET | typeof CODEX;
  readonly minutesAgo: number;
  readonly branch?: string;
  readonly working?: boolean;
  readonly approval?: boolean;
}

const MOCK_FLEET: readonly MockSpec[] = [
  { id: "fm", title: "First Mate", role: "first-mate", repo: null, model: OPUS, minutesAgo: 1 },
  {
    id: "sm-firstmate",
    title: "Keep the fleet daemon healthy",
    role: "second-mate",
    repo: "firstmate",
    model: OPUS,
    minutesAgo: 3,
  },
  {
    id: "sm-t3code",
    title: "Fork upkeep and fleet sidebar",
    role: "second-mate",
    repo: "t3code",
    model: OPUS,
    minutesAgo: 12,
    working: true,
  },
  {
    id: "sm-lavish",
    title: "Review surface polish",
    role: "second-mate",
    repo: "lavish-axi",
    model: OPUS,
    minutesAgo: 95,
  },
  {
    id: "w-quota",
    title: "Quota dispatch headroom gate",
    role: "worker",
    repo: "firstmate",
    model: CODEX,
    minutesAgo: 5,
    branch: "feat/quota-headroom",
    working: true,
  },
  {
    id: "w-diff",
    title: "Diff pages reload after a reconnect",
    role: "worker",
    repo: "t3code",
    model: SONNET,
    minutesAgo: 40,
    branch: "fix/diff-page-reload",
  },
  {
    id: "w-env",
    title: "Deferred turn keeps its environment",
    role: "worker",
    repo: "t3code",
    model: OPUS,
    minutesAgo: 7,
    branch: "feat/deferred-turn-env",
    approval: true,
  },
  {
    id: "w-tree",
    title: "Fleet sidebar tree",
    role: "worker",
    repo: "t3code",
    model: OPUS,
    minutesAgo: 2,
    branch: "feat/fleet-sidebar-tree",
    working: true,
  },
];

/** Mock fleet threads on the given environment, fixed relative to `now`. */
export function buildPrototypeFleetThreads(
  environmentId: EnvironmentId,
  now: number,
): EnvironmentThreadShell[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return MOCK_FLEET.map((spec, index) => {
    const threadId = ThreadId.make(`prototype-${spec.id}`);
    const turnId = TurnId.make(`prototype-${spec.id}-turn`);
    return {
      environmentId,
      id: threadId,
      projectId: ProjectId.make(`prototype-${spec.repo ?? "fleet"}`),
      title: spec.title,
      modelSelection: spec.model,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: spec.branch ?? null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: {
        turnId,
        state: spec.working ? "running" : "completed",
        requestedAt: ago(spec.minutesAgo + 2),
        startedAt: ago(spec.minutesAgo + 2),
        completedAt: spec.working ? null : ago(spec.minutesAgo),
        assistantMessageId: null,
      },
      // Launch order follows the list, so workers keep this order.
      createdAt: ago(600 - index),
      updatedAt: ago(spec.minutesAgo),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      readOnly: spec.role !== "first-mate",
      fleetRole: spec.role,
      fleetRepo: spec.repo,
      session: spec.working
        ? {
            threadId,
            status: "running",
            providerName: null,
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: ago(spec.minutesAgo),
          }
        : null,
      latestUserMessageAt: ago(spec.minutesAgo + 2),
      hasPendingApprovals: spec.approval === true,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies EnvironmentThreadShell;
  });
}

export type FleetRowLayout = {
  readonly variant?: "card" | "slim";
  readonly rowClassName?: string;
  readonly words?: "full" | "compact" | undefined;
  /** Makes the row's pin a local toggle. */
  readonly onTogglePin?: (() => void) | undefined;
  /** A second mate's lane toggle. */
  readonly lane?: { readonly expanded: boolean; readonly onToggle: () => void } | undefined;
};

export interface FleetPrototypeState {
  readonly firstMateRunning: boolean;
  readonly firstMatePinned: boolean;
  readonly collapsed: ReadonlySet<string>;
  readonly onTogglePin: () => void;
  readonly onStartFirstMate: () => void;
  readonly onOpenFirstMate: () => void;
  readonly onRowClick: (title: string) => void;
  readonly onToggleLane: (repo: string) => void;
}

function FleetHeaderRow(props: {
  label: string;
  toggle?: { expanded: boolean; onToggle: () => void };
}) {
  const content = (
    <>
      <span className="shrink-0">{props.label}</span>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
      {props.toggle ? (
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            !props.toggle.expanded && "-rotate-90",
          )}
        />
      ) : null}
    </>
  );
  return (
    <li className="mx-0.5 flex h-8 list-none">
      {props.toggle ? (
        <button
          type="button"
          aria-expanded={props.toggle.expanded}
          onClick={props.toggle.onToggle}
          className="flex h-full w-full cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium text-sidebar-muted-foreground/60 hover:text-sidebar-foreground"
        >
          {content}
        </button>
      ) : (
        <span className="flex h-full w-full items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60">
          {content}
        </span>
      )}
    </li>
  );
}

function StartFirstMateRow(props: { onStart: () => void; className?: string; label?: string }) {
  return (
    <li className="flex list-none">
      <button
        type="button"
        onClick={props.onStart}
        className={cn(
          "flex h-9 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium",
          props.className,
        )}
      >
        {props.label ?? "Start First Mate"}
      </button>
    </li>
  );
}

const PINK_BAR =
  "rounded-lg bg-pink-100 ring-1 ring-pink-500/40 dark:bg-pink-900/45 dark:ring-pink-400/35";

/** The fleet rows for one variant, in sidebar order. */
export function renderFleetPrototype(input: {
  variant: FleetPrototypeVariant;
  firstMate: EnvironmentThreadShell | null;
  branches: readonly FleetBranch<EnvironmentThreadShell>[];
  state: FleetPrototypeState;
  renderRow: (thread: EnvironmentThreadShell, layout: FleetRowLayout, locked: boolean) => ReactNode;
}): ReactNode[] {
  const { variant, firstMate, branches, state, renderRow } = input;
  const items: ReactNode[] = [];
  const lane = (branch: FleetBranch<EnvironmentThreadShell>) =>
    branch.workers.length > 0
      ? {
          expanded: !state.collapsed.has(branch.repo),
          onToggle: () => state.onToggleLane(branch.repo),
        }
      : undefined;
  const visibleWorkers = (branch: FleetBranch<EnvironmentThreadShell>) =>
    state.collapsed.has(branch.repo) ? [] : branch.workers;
  const pinnedSticky = "sticky top-0 z-20";

  if (variant === "A") {
    const trunk = firstMate ? "ml-3.5 border-l border-sidebar-border" : "";
    if (firstMate) {
      items.push(
        renderRow(
          firstMate,
          {
            onTogglePin: state.onTogglePin,
            rowClassName: cn(state.firstMatePinned && `${pinnedSticky} bg-sidebar`),
          },
          true,
        ),
      );
    }
    for (const branch of branches) {
      if (branch.secondMate) {
        items.push(
          renderRow(
            branch.secondMate,
            { rowClassName: cn(trunk, firstMate && "pl-2"), lane: lane(branch) },
            true,
          ),
        );
      }
      for (const worker of visibleWorkers(branch)) {
        items.push(
          renderRow(
            worker,
            {
              variant: "slim",
              rowClassName: cn(
                "relative before:absolute before:inset-y-0 before:w-px before:bg-sidebar-border",
                firstMate ? `${trunk} pl-6 before:left-[1.1rem]` : "pl-4 before:left-[0.6rem]",
              ),
            },
            false,
          ),
        );
      }
    }
    items.push(<li key="fleet-gap" aria-hidden className="h-2 list-none" />);
    return items;
  }

  if (variant === "C") {
    const firstMateRow = firstMate ? (
      renderRow(
        firstMate,
        {
          variant: "slim",
          onTogglePin: state.onTogglePin,
          rowClassName: cn(state.firstMatePinned && `${pinnedSticky} bg-sidebar`),
        },
        true,
      )
    ) : (
      <StartFirstMateRow
        key="start-first-mate"
        onStart={state.onStartFirstMate}
        className="text-pink-700 hover:bg-sidebar-row-hover dark:text-pink-300"
        label="First Mate - not running. Start"
      />
    );
    const fleetOpen = !state.collapsed.has("*fleet");
    const count = branches.reduce(
      (total, branch) => total + branch.workers.length + (branch.secondMate ? 1 : 0),
      firstMate ? 1 : 0,
    );
    if (firstMate && state.firstMatePinned) items.push(firstMateRow);
    items.push(
      <FleetHeaderRow
        key="fleet-header"
        label={`Fleet (${count})`}
        toggle={{ expanded: fleetOpen, onToggle: () => state.onToggleLane("*fleet") }}
      />,
    );
    if (fleetOpen) {
      if (!(firstMate && state.firstMatePinned)) items.push(firstMateRow);
      for (const branch of branches) {
        if (branch.secondMate) {
          items.push(renderRow(branch.secondMate, { variant: "slim", lane: lane(branch) }, true));
        }
        for (const worker of visibleWorkers(branch)) {
          items.push(
            renderRow(
              worker,
              {
                variant: "slim",
                rowClassName:
                  "relative pl-6 before:absolute before:inset-y-1 before:left-[1.1rem] before:w-px before:bg-sidebar-border",
              },
              false,
            ),
          );
        }
      }
    }
    items.push(<FleetHeaderRow key="threads-header" label="Threads" />);
    return items;
  }

  // B, B-words and B-words-compact: lanes under a pink First Mate bar.
  const words = variant === "B" ? undefined : "full";
  const workerWords = variant === "B-words-compact" ? "compact" : words;
  const firstMateInList = firstMate !== null && !state.firstMatePinned;
  if (firstMate === null) {
    items.push(
      <StartFirstMateRow
        key="start-first-mate"
        onStart={state.onStartFirstMate}
        className={cn(PINK_BAR, "mb-1 text-pink-950 dark:text-pink-50")}
      />,
    );
  } else if (state.firstMatePinned) {
    items.push(
      renderRow(
        firstMate,
        {
          variant: "slim",
          words,
          onTogglePin: state.onTogglePin,
          rowClassName: cn(pinnedSticky, "mb-1", PINK_BAR),
        },
        true,
      ),
    );
  }
  items.push(<FleetHeaderRow key="fleet-header" label="Fleet" />);
  if (firstMateInList && firstMate) {
    items.push(renderRow(firstMate, { words, onTogglePin: state.onTogglePin }, true));
  }
  // A lane's rail marks it. The words variants give the text the room and keep
  // the rail thin so "Second mate - lavish-axi" fits the default width.
  const secondMateRail =
    words === undefined
      ? "border-l-2 border-sky-500/60 pl-1 dark:border-sky-400/60"
      : "border-l-2 border-sky-500/60 dark:border-sky-400/60";
  const workerRail =
    words === undefined
      ? "ml-3 border-l-2 border-sky-500/20 pl-1 dark:border-sky-400/20"
      : "ml-2 border-l-2 border-sky-500/20 dark:border-sky-400/20";
  branches.forEach((branch, index) => {
    if (index > 0) {
      items.push(<li key={`lane-gap-${branch.repo}`} aria-hidden className="h-1.5 list-none" />);
    }
    if (branch.secondMate) {
      items.push(
        renderRow(
          branch.secondMate,
          { words, rowClassName: secondMateRail, lane: lane(branch) },
          true,
        ),
      );
    }
    for (const worker of visibleWorkers(branch)) {
      items.push(renderRow(worker, { words: workerWords, rowClassName: workerRail }, false));
    }
  });
  items.push(<FleetHeaderRow key="threads-header" label="Threads" />);
  return items;
}

/** A toolbar icon that opens First Mate, or starts one; variant A's control. */
export function prototypeFirstMateControlLabel(running: boolean): string {
  return running ? "Open First Mate" : "Start First Mate";
}

function isTypingTarget(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.isContentEditable ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

/**
 * The prototype's own control, floating at the bottom centre and styled apart
 * from the app: step through the variants with the arrows or the arrow keys.
 */
export function FleetSidebarPrototypeBar() {
  const variant = useFleetPrototypeVariant();
  const running = usePrototypeFirstMateRunning();
  const index = FLEET_PROTOTYPE_VARIANTS.findIndex((entry) => entry.key === variant);
  useEffect(() => {
    if (variant === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTypingTarget(document.activeElement)) return;
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  if (!import.meta.env.DEV || variant === null) return null;
  const current = FLEET_PROTOTYPE_VARIANTS[index]!;
  const count = FLEET_PROTOTYPE_VARIANTS.length;
  function step(delta: number) {
    setVariant(FLEET_PROTOTYPE_VARIANTS[(index + delta + count) % count]!.key);
  }
  const button =
    "inline-flex size-7 cursor-pointer items-center justify-center rounded-full hover:bg-amber-950/10 dark:hover:bg-amber-50/15";
  // Portalled to the body so no app stacking context can cover it.
  return createPortal(
    <div className="fixed bottom-4 left-1/2 z-[1000] flex whitespace-nowrap -translate-x-1/2 items-center gap-1 rounded-full border-2 border-dashed border-amber-600 bg-amber-100 px-1.5 py-1 font-mono text-xs text-amber-950 shadow-lg dark:border-amber-400 dark:bg-amber-950 dark:text-amber-50">
      <span className="px-1.5 text-[10px] font-bold uppercase tracking-wider opacity-70">
        Prototype
      </span>
      <button
        type="button"
        aria-label="Previous variant"
        className={button}
        onClick={() => step(-1)}
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <span className="min-w-56 text-center">
        <span className="font-bold">{current.key}</span> - {current.name}
      </span>
      <button type="button" aria-label="Next variant" className={button} onClick={() => step(1)}>
        <ChevronRightIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => setPrototypeFirstMateRunning(!running)}
        className="ml-1 cursor-pointer rounded-full px-2 py-1 hover:bg-amber-950/10 dark:hover:bg-amber-50/15"
      >
        First Mate: {running ? "running" : "not running"}
      </button>
      <button
        type="button"
        aria-label="Leave the prototype"
        className={button}
        onClick={() => setVariant(null)}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>,
    document.body,
  );
}
