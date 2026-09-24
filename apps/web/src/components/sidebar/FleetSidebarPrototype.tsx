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
  type ProjectIconColor,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  AnchorIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CompassIcon,
  BotIcon,
  BrainIcon,
  CogIcon,
  CpuIcon,
  CrownIcon,
  FlagIcon,
  HammerIcon,
  type LucideIcon,
  MapIcon,
  NavigationIcon,
  PickaxeIcon,
  SailboatIcon,
  ShipIcon,
  SparklesIcon,
  StarIcon,
  TelescopeIcon,
  UsersIcon,
  HardHatIcon,
  ShipWheelIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { projectIconColorClassName } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";
import type { FleetBranch } from "../Sidebar.logic";

export const FLEET_PROTOTYPE_VARIANTS = [
  { key: "N1", name: "Tree under First Mate" },
  { key: "N2", name: "Flat second mates" },
  { key: "N3", name: "Flat second mates, folded" },
  { key: "N2b", name: "N2, coloured roles and effort" },
  { key: "N2d", name: "semibold roles, project colours, wheel icons" },
  { key: "N2e", name: "bold titles, palette, wheel icons" },
  { key: "N2f", name: "whole row, project colours, crown icons" },
  { key: "N2g", name: "semibold titles, indigo shades, crown icons" },
  { key: "N2h", name: "bold title and role, palette, crown icons" },
  { key: "V1", name: "icon only, medium titles, cool" },
  { key: "V2", name: "bold role words, warm, no icons" },
  { key: "V3", name: "coloured project names, project colours" },
  { key: "V4", name: "muted whole row, grey icons" },
  { key: "V5", name: "bold titles, grey crown icons, palette" },
  { key: "V6", name: "medium roles, ship icons, cool" },
  { key: "V7", name: "icon only, semibold titles, project colours" },
  { key: "V8", name: "bold whole row, warm, sparkles icons" },
  { key: "V9", name: "project name and role, indigo shades" },
  { key: "V10", name: "plain titles, muted palette, no icons" },
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

// Light-mode text needs a darker step for the pale hues: their -600 icon
// shade falls under 4.5:1 on the light sidebar. Dark mode keeps the icon shade.
const TEXT_SHADE_OVERRIDES: Partial<Record<ProjectIconColor, string>> = {
  amber: "text-amber-700 dark:text-amber-400",
  yellow: "text-yellow-700 dark:text-yellow-400",
  lime: "text-lime-700 dark:text-lime-400",
  green: "text-green-700 dark:text-green-400",
  emerald: "text-emerald-700 dark:text-emerald-400",
  teal: "text-teal-700 dark:text-teal-400",
  cyan: "text-cyan-700 dark:text-cyan-400",
};

interface ColouredProject {
  readonly title: string;
  readonly projectIcon?:
    | { readonly kind: string; readonly color?: ProjectIconColor | undefined }
    | null
    | undefined;
}

/**
 * N2c's role word colour: the colour the app gives this project's icon. An
 * icon the user picked carries its colour; with no icon the monogram colour
 * comes from the project's name, the same derivation the icon uses. An emoji
 * or image icon has no single colour, so the word stays grey.
 */
export function prototypeProjectTextClassName(project: ColouredProject | null): string | undefined {
  if (project === null) return undefined;
  const icon = project.projectIcon;
  const color = icon ? icon.color : deriveProjectIdentity(project.title).color;
  if (color === undefined) return undefined;
  return TEXT_SHADE_OVERRIDES[color] ?? projectIconColorClassName(color);
}

// N2c's mock projects: distinct monogram colours so the effect shows. Pink
// stays First Mate's alone.
const MOCK_PROJECT_ICONS: Record<
  string,
  { readonly text: string; readonly color: ProjectIconColor }
> = {
  firstmate: { text: "FM", color: "orange" },
  t3code: { text: "T3", color: "indigo" },
  "lavish-axi": { text: "LA", color: "emerald" },
};

/** A fleet row's project with N2c's mock icon, when its repository has one. */
export function prototypeMockProject<T extends ColouredProject>(
  project: T,
  repo: string | null,
): T {
  const icon = repo === null ? undefined : MOCK_PROJECT_ICONS[repo];
  return icon ? { ...project, projectIcon: { kind: "monogram", ...icon } } : project;
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

/**
 * How N2d to N2h dress a fleet row. Every main thread (First Mate and each
 * second mate) gets its own text colour; a worker takes its second mate's
 * colour, faded, at regular weight.
 */
export interface PrototypeLook {
  /** Which text carries the colour. */
  readonly target: "role" | "title" | "row" | "title-role" | "project" | "project-role";
  /** Weight of the coloured text on main threads. Workers stay regular. */
  readonly mainWeight: "font-normal" | "font-medium" | "font-semibold" | "font-bold";
  /** The role as its word, as its icon, or both. */
  readonly role?: "text" | "icon" | "both" | undefined;
  readonly icons: "none" | "wheel" | "crown" | "star" | "ship" | "brain" | "telescope" | "sparkles";
  /** In place of the project icon, or just after it. */
  readonly placement: "replace" | "beside";
  /** The icon in the thread's colour, or plain grey. */
  readonly iconTone?: "match" | "muted" | undefined;
}

type Scheme = "project" | "palette" | "accent" | "warm" | "cool" | "muted";

const LOOKS: Partial<Record<FleetPrototypeVariant, PrototypeLook & { readonly scheme: Scheme }>> = {
  N2d: {
    target: "role",
    mainWeight: "font-semibold",
    icons: "wheel",
    placement: "beside",
    scheme: "project",
  },
  N2e: {
    target: "title",
    mainWeight: "font-bold",
    icons: "wheel",
    placement: "replace",
    scheme: "palette",
  },
  N2f: {
    target: "row",
    mainWeight: "font-semibold",
    icons: "crown",
    placement: "beside",
    scheme: "project",
  },
  N2g: {
    target: "title",
    mainWeight: "font-semibold",
    icons: "crown",
    placement: "replace",
    scheme: "accent",
  },
  N2h: {
    target: "title-role",
    mainWeight: "font-bold",
    icons: "crown",
    placement: "replace",
    scheme: "palette",
  },
  V1: {
    target: "title",
    mainWeight: "font-medium",
    role: "icon",
    icons: "telescope",
    placement: "replace",
    iconTone: "match",
    scheme: "cool",
  },
  V2: {
    target: "role",
    mainWeight: "font-bold",
    role: "text",
    icons: "none",
    placement: "beside",
    scheme: "warm",
  },
  V3: {
    target: "project",
    mainWeight: "font-semibold",
    role: "both",
    icons: "wheel",
    placement: "beside",
    iconTone: "match",
    scheme: "project",
  },
  V4: {
    target: "row",
    mainWeight: "font-normal",
    role: "both",
    icons: "brain",
    placement: "replace",
    iconTone: "muted",
    scheme: "muted",
  },
  V5: {
    target: "title",
    mainWeight: "font-bold",
    role: "both",
    icons: "crown",
    placement: "replace",
    iconTone: "muted",
    scheme: "palette",
  },
  V6: {
    target: "role",
    mainWeight: "font-medium",
    role: "both",
    icons: "ship",
    placement: "beside",
    iconTone: "match",
    scheme: "cool",
  },
  V7: {
    target: "title",
    mainWeight: "font-semibold",
    role: "icon",
    icons: "star",
    placement: "beside",
    iconTone: "match",
    scheme: "project",
  },
  V8: {
    target: "row",
    mainWeight: "font-bold",
    role: "both",
    icons: "sparkles",
    placement: "replace",
    iconTone: "match",
    scheme: "warm",
  },
  V9: {
    target: "project-role",
    mainWeight: "font-medium",
    role: "both",
    icons: "wheel",
    placement: "replace",
    iconTone: "muted",
    scheme: "accent",
  },
  V10: {
    target: "title",
    mainWeight: "font-normal",
    role: "text",
    icons: "none",
    placement: "beside",
    scheme: "muted",
  },
};

// One colour per second mate, in repo order, for each scheme. First Mate
// keeps a pink of the scheme's strength.
const SCHEME_TONES: Record<Exclude<Scheme, "project">, readonly string[]> = {
  palette: [
    "text-violet-600 dark:text-violet-400",
    "text-teal-700 dark:text-teal-400",
    "text-orange-600 dark:text-orange-400",
  ],
  accent: [
    "text-indigo-700 dark:text-indigo-300",
    "text-indigo-600 dark:text-indigo-400",
    "text-indigo-500 dark:text-indigo-500",
  ],
  warm: [
    "text-amber-700 dark:text-amber-400",
    "text-orange-600 dark:text-orange-400",
    "text-rose-600 dark:text-rose-400",
  ],
  cool: [
    "text-sky-700 dark:text-sky-300",
    "text-teal-700 dark:text-teal-300",
    "text-indigo-600 dark:text-indigo-300",
  ],
  muted: [
    "text-indigo-900/75 dark:text-indigo-200/80",
    "text-emerald-900/75 dark:text-emerald-200/80",
    "text-amber-900/75 dark:text-amber-200/80",
  ],
};

function firstMateTone(scheme: Scheme): string {
  return scheme === "muted"
    ? "text-pink-900/80 dark:text-pink-200/85"
    : "text-pink-600 dark:text-pink-400";
}

function mateTone(scheme: Scheme, repo: string, index: number): string | undefined {
  if (scheme === "project") {
    const icon = MOCK_PROJECT_ICONS[repo];
    return icon
      ? (TEXT_SHADE_OVERRIDES[icon.color] ?? projectIconColorClassName(icon.color))
      : undefined;
  }
  const tones = SCHEME_TONES[scheme];
  return tones[index % tones.length];
}

const ICON_SETS: Record<
  Exclude<PrototypeLook["icons"], "none">,
  readonly [first: LucideIcon, second: LucideIcon, worker: LucideIcon]
> = {
  wheel: [ShipWheelIcon, AnchorIcon, WrenchIcon],
  crown: [CrownIcon, CompassIcon, HardHatIcon],
  star: [StarIcon, FlagIcon, HammerIcon],
  ship: [ShipIcon, SailboatIcon, PickaxeIcon],
  brain: [BrainIcon, UsersIcon, BotIcon],
  telescope: [TelescopeIcon, MapIcon, CogIcon],
  sparkles: [SparklesIcon, NavigationIcon, CpuIcon],
};

/** A fleet role's icon from one of the candidate sets. */
export function PrototypeRoleIcon(props: {
  readonly set: PrototypeLook["icons"];
  readonly role: string | null | undefined;
  readonly className?: string | undefined;
}) {
  if (props.set === "none") return null;
  const [first, second, worker] = ICON_SETS[props.set];
  const Icon = props.role === "first-mate" ? first : props.role === "second-mate" ? second : worker;
  return <Icon aria-hidden className={props.className} />;
}

/** One fleet row to draw: the thread, its indent, and its fold arrow if it has children. */
export interface PrototypeFleetEntry {
  readonly thread: EnvironmentThreadShell;
  readonly depth: 0 | 1 | 2;
  readonly fold?: { readonly key: string; readonly expanded: boolean } | undefined;
  /** Grey text after the model, such as "3 workers". */
  readonly note?: string | undefined;
  /** N2b: the role word in its colour and the reasoning level after the model. */
  readonly accent?: "fixed" | "project" | undefined;
  /** N2b: a divider under the pinned First Mate row. */
  readonly dividerAfter?: boolean | undefined;
  /** N2d to N2h: how the row is dressed, its colour, and whether it is a main thread. */
  readonly look?: PrototypeLook | undefined;
  readonly tone?: string | undefined;
  readonly main?: boolean | undefined;
  /** Give the row's project a mock monogram icon, so project colours show. */
  readonly mockProject?: boolean | undefined;
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
  const lookSpec = LOOKS[variant];
  const look: PrototypeLook | undefined = lookSpec;
  const accent = variant === "N2b" || lookSpec ? "fixed" : undefined;
  const mockProject = lookSpec?.scheme === "project";
  const mates: PrototypeFleetEntry[] = [];
  let mateIndex = 0;
  for (const branch of branches) {
    if (branch.secondMate === null) continue;
    const expanded = isExpanded(branch.repo);
    const count = branch.workers.length;
    const tone = lookSpec ? mateTone(lookSpec.scheme, branch.repo, mateIndex++) : undefined;
    mates.push({
      thread: branch.secondMate,
      depth: tree ? 1 : 0,
      accent,
      look,
      tone,
      main: true,
      mockProject,
      fold: count > 0 ? { key: branch.repo, expanded } : undefined,
      note:
        variant === "N3" && count > 0
          ? `${count} ${count === 1 ? "worker" : "workers"}`
          : undefined,
    });
    if (!expanded) continue;
    for (const worker of branch.workers) {
      mates.push({
        thread: worker,
        depth: tree ? 2 : 1,
        accent,
        look,
        tone,
        main: false,
        mockProject,
      });
    }
  }
  const firstMateEntry: PrototypeFleetEntry | null = firstMate
    ? {
        thread: firstMate,
        depth: 0,
        accent,
        look,
        tone: lookSpec ? firstMateTone(lookSpec.scheme) : undefined,
        main: true,
        mockProject,
        dividerAfter: accent !== undefined && input.firstMatePinned,
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
