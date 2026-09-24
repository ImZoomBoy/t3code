// PROTOTYPE - throwaway nested fleet sidebar variants for a design review.
//
// Open the dev app with ?variant=N1, N2 or N3. The real sidebar then nests
// mock fleet threads under each other using today's thread rows. Every export
// is inert unless import.meta.env.DEV, so a production build never shows the
// variants, the mock data, or the floating bar. Nothing here sends a command:
// the pin and the fold arrows only change local state.

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { FleetBranch } from "../Sidebar.logic";

export const FLEET_PROTOTYPE_VARIANTS = [
  { key: "N1", name: "Tree under First Mate" },
  { key: "N2", name: "Flat second mates" },
  { key: "N2b", name: "N2, coloured roles and effort" },
  { key: "N3", name: "Flat second mates, folded" },
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

export function isPrototypeThread(thread: { readonly id: string }): boolean {
  return thread.id.startsWith("prototype-");
}

/**
 * N2b's role word colour: First Mate keeps its pink, second mates violet and
 * workers teal. None of the three is a status colour (blue working, amber
 * approval, red failed, green done), so a role never reads as a state.
 */
export function prototypeRoleClassName(thread: {
  readonly fleetRole?: string | null | undefined;
}): string | undefined {
  switch (thread.fleetRole) {
    case "first-mate":
      return "text-pink-600 dark:text-pink-400";
    case "second-mate":
      return "text-violet-600 dark:text-violet-400";
    case "worker":
      return "text-teal-700 dark:text-teal-400";
    default:
      return undefined;
  }
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The reasoning level a model selection runs at, in words, or null when it has none. */
export function prototypeEffortLabel(selection: {
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }> | undefined;
}): string | null {
  const option = selection.options?.find(
    (entry) => entry.id === "effort" || entry.id === "reasoningEffort",
  );
  return typeof option?.value === "string" ? (EFFORT_LABELS[option.value] ?? option.value) : null;
}

/** The grey role word a fleet row shows where the model name sits. */
export function prototypeRoleWord(thread: {
  readonly fleetRole?: string | null | undefined;
}): string | null {
  switch (thread.fleetRole) {
    case "first-mate":
      return "First Mate";
    case "second-mate":
      return "Second mate";
    case "worker":
      return "Worker";
    default:
      return null;
  }
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
  readonly repo: string;
  readonly model: typeof OPUS | typeof SONNET | typeof CODEX;
  readonly minutesAgo: number;
  readonly branch?: string;
  readonly working?: boolean;
  readonly approval?: boolean;
  readonly effort: "low" | "medium" | "high" | "xhigh";
}

const MOCK_FLEET: readonly MockSpec[] = [
  {
    id: "fm",
    effort: "medium",
    title: "First Mate",
    role: "first-mate",
    repo: "firstmate",
    model: OPUS,
    minutesAgo: 1,
  },
  {
    id: "sm-firstmate",
    effort: "high",
    title: "Keep the fleet daemon healthy",
    role: "second-mate",
    repo: "firstmate",
    model: OPUS,
    minutesAgo: 3,
  },
  {
    id: "sm-t3code",
    effort: "high",
    title: "Fork upkeep and fleet sidebar",
    role: "second-mate",
    repo: "t3code",
    model: OPUS,
    minutesAgo: 12,
    working: true,
  },
  {
    id: "sm-lavish",
    effort: "medium",
    title: "Review surface polish",
    role: "second-mate",
    repo: "lavish-axi",
    model: OPUS,
    minutesAgo: 95,
  },
  {
    id: "w-quota",
    effort: "xhigh",
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
    effort: "low",
    title: "Diff pages reload after a reconnect",
    role: "worker",
    repo: "t3code",
    model: SONNET,
    minutesAgo: 40,
    branch: "fix/diff-page-reload",
  },
  {
    id: "w-env",
    effort: "high",
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
    effort: "medium",
    title: "Fleet sidebar tree",
    role: "worker",
    repo: "t3code",
    model: OPUS,
    minutesAgo: 2,
    branch: "feat/fleet-sidebar-tree",
    working: true,
  },
];

/**
 * Mock fleet threads on the given environment, fixed relative to `now`. Each
 * sits in the project named after its repository when one exists, so the rows
 * show a real project the way ordinary rows do.
 */
export function buildPrototypeFleetThreads(
  environmentId: EnvironmentId,
  now: number,
  projectIdForRepo: (repo: string) => ProjectId | null,
): EnvironmentThreadShell[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return MOCK_FLEET.map((spec, index) => {
    const threadId = ThreadId.make(`prototype-${spec.id}`);
    const turnId = TurnId.make(`prototype-${spec.id}-turn`);
    return {
      environmentId,
      id: threadId,
      projectId: projectIdForRepo(spec.repo) ?? ProjectId.make(`prototype-${spec.repo}`),
      title: spec.title,
      modelSelection: {
        ...spec.model,
        options: [
          ...("options" in spec.model ? spec.model.options : []),
          { id: "effort", value: spec.effort },
        ],
      },
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
      fleetRepo: spec.role === "first-mate" ? null : spec.repo,
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

/** One fleet row to draw: the thread, its indent, and its fold arrow if it has children. */
export interface PrototypeFleetEntry {
  readonly thread: EnvironmentThreadShell;
  readonly depth: 0 | 1 | 2;
  readonly fold?: { readonly key: string; readonly expanded: boolean } | undefined;
  /** Grey text after the model, such as "3 workers". */
  readonly note?: string | undefined;
  /** N2b: the role word in its colour and the reasoning level after the model. */
  readonly accent?: boolean | undefined;
  /** N2b: a divider under the pinned First Mate row. */
  readonly dividerAfter?: boolean | undefined;
}

const FIRST_MATE_FOLD = "first-mate";

/**
 * Where each fleet row goes for a variant. `top` sits above every ordinary
 * thread. `underFirstMate` follows the First Mate row wherever it is: the top
 * while pinned, and its place among active threads once unpinned.
 */
export function planPrototypeFleetRows(input: {
  readonly variant: FleetPrototypeVariant;
  readonly firstMate: EnvironmentThreadShell | null;
  readonly firstMatePinned: boolean;
  readonly branches: readonly FleetBranch<EnvironmentThreadShell>[];
  readonly isExpanded: (key: string) => boolean;
}): {
  readonly top: PrototypeFleetEntry[];
  readonly firstMateEntry: PrototypeFleetEntry | null;
  readonly underFirstMate: PrototypeFleetEntry[];
} {
  const { variant, firstMate, branches, isExpanded } = input;
  const tree = variant === "N1";
  const accent = variant === "N2b";
  const mates: PrototypeFleetEntry[] = [];
  for (const branch of branches) {
    if (branch.secondMate === null) continue;
    const expanded = isExpanded(branch.repo);
    const count = branch.workers.length;
    mates.push({
      thread: branch.secondMate,
      depth: tree ? 1 : 0,
      accent,
      fold: count > 0 ? { key: branch.repo, expanded } : undefined,
      note:
        variant === "N3" && count > 0
          ? `${count} ${count === 1 ? "worker" : "workers"}`
          : undefined,
    });
    if (!expanded) continue;
    for (const worker of branch.workers) {
      mates.push({ thread: worker, depth: tree ? 2 : 1, accent });
    }
  }
  const firstMateEntry: PrototypeFleetEntry | null = firstMate
    ? {
        thread: firstMate,
        depth: 0,
        accent,
        dividerAfter: accent && input.firstMatePinned,
        fold:
          tree && mates.length > 0
            ? { key: FIRST_MATE_FOLD, expanded: isExpanded(FIRST_MATE_FOLD) }
            : undefined,
      }
    : null;
  const underFirstMate = tree && isExpanded(FIRST_MATE_FOLD) ? mates : [];
  const top: PrototypeFleetEntry[] = [];
  if (firstMateEntry && input.firstMatePinned) top.push(firstMateEntry, ...underFirstMate);
  if (!tree) top.push(...mates);
  return { top, firstMateEntry, underFirstMate };
}

/** Whether a fold starts open: N3 folds second mates by default. */
export function prototypeFoldStartsOpen(variant: FleetPrototypeVariant, key: string): boolean {
  return !(variant === "N3" && key !== FIRST_MATE_FOLD);
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
  const index = FLEET_PROTOTYPE_VARIANTS.findIndex((entry) => entry.key === variant);
  const count = FLEET_PROTOTYPE_VARIANTS.length;
  function step(delta: number) {
    setVariant(FLEET_PROTOTYPE_VARIANTS[(index + delta + count) % count]!.key);
  }
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
  const button =
    "inline-flex size-7 cursor-pointer items-center justify-center rounded-full hover:bg-amber-950/10 dark:hover:bg-amber-50/15";
  // Portalled to the body so no app stacking context can cover it.
  return createPortal(
    <div className="fixed bottom-4 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border-2 border-dashed border-amber-600 bg-amber-100 px-1.5 py-1 font-mono text-xs text-amber-950 shadow-lg dark:border-amber-400 dark:bg-amber-950 dark:text-amber-50">
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
      <span className="min-w-52 text-center">
        <span className="font-bold">{current.key}</span> - {current.name}
      </span>
      <button type="button" aria-label="Next variant" className={button} onClick={() => step(1)}>
        <ChevronRightIcon className="size-4" />
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
