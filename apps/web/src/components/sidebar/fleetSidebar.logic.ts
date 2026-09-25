import type { FleetRole } from "@t3tools/contracts";
import type { FleetThreadFields } from "@t3tools/client-runtime/fleet-threads";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

/**
 * How the sidebar arranges and colours First Mate's fleet. A worker belongs to
 * the second mate whose `fleetRepo` it shares: First Mate sends the same
 * repository key for both, and nothing else links them.
 */

type FleetThread = FleetThreadFields & {
  readonly id: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly pinnedAt?: string | null | undefined;
};

/** What the top of the sidebar shows: a Start First Mate row, or the First Mate threads. */
export type FirstMateSlot<T> =
  | { readonly kind: "start" }
  | {
      readonly kind: "first-mates";
      /** The main First Mate: the pinned one, or the most recent live one. */
      readonly main: T;
      /** Any other live First Mates, newest first, listed under the main one. */
      readonly others: readonly T[];
      /** First Mate rows carry a pin toggle: the pin marks the main one. */
      readonly pin: "toggle";
    };

const newestFirst = (left: { readonly createdAt: string }, right: { readonly createdAt: string }) =>
  right.createdAt.localeCompare(left.createdAt);

/**
 * The top of the sidebar. First Mate always sits there, pinned or not. When
 * several First Mate threads are live, the pin marks the main one; with none
 * pinned, the most recent one leads. With none live, the slot offers to start one.
 */
export function planFirstMateSlot<T extends FleetThread>(threads: readonly T[]): FirstMateSlot<T> {
  const live = threads
    .filter((thread) => thread.fleetRole === "first-mate" && thread.archivedAt === null)
    .toSorted(newestFirst);
  const pinned = live
    .filter((thread) => thread.pinnedAt != null)
    .toSorted((left, right) => right.pinnedAt!.localeCompare(left.pinnedAt!));
  const main = pinned[0] ?? live[0];
  if (main === undefined) return { kind: "start" };
  return {
    kind: "first-mates",
    main,
    others: live.filter((thread) => thread !== main),
    pin: "toggle",
  };
}

/** One second mate and the workers it launched. */
export interface FleetBranch<T> {
  /** The shared `fleetRepo`, or null for fleet threads that name none. */
  readonly repo: string | null;
  /** Null when workers run in a repository that has no live second mate. */
  readonly secondMate: T | null;
  readonly workers: readonly T[];
}

/**
 * Pull second mates and their workers out of the thread list into a tree.
 * Branches sort by repository name and workers by launch order, never by
 * activity, so no fleet row moves when a thread gets busy.
 *
 * A parked worker leaves the tree for its section, Settled or Snoozed, and
 * comes back when un-settled or woken. A settled second mate leaves with all
 * of its workers, and each worker lists by its own state: a settled one in
 * Settled, a snoozed one in Snoozed, a live one in Active or Pinned. Settled
 * rows carry Un-settle, which means nothing to a worker that is not settled.
 * A snoozed second mate stays in the tree with its wake control.
 *
 * Every thread that is not in the tree passes through to `rest` in its
 * original order.
 */
export function buildFleetTree<T extends FleetThread>(
  threads: readonly T[],
  options: { readonly parkedState: (thread: T) => FleetParked },
): { readonly branches: FleetBranch<T>[]; readonly rest: T[] } {
  const inFleet = (thread: T) =>
    thread.archivedAt === null &&
    (thread.fleetRole === "second-mate" || thread.fleetRole === "worker");
  // One second mate per repository: the newer one leads, an older one lists
  // as an ordinary thread rather than vanishing.
  const leads = new Map<string | null, T>();
  for (const thread of threads) {
    if (!inFleet(thread) || thread.fleetRole !== "second-mate") continue;
    const repo = thread.fleetRepo ?? null;
    const lead = leads.get(repo);
    if (lead === undefined || thread.createdAt > lead.createdAt) leads.set(repo, thread);
  }
  const settledRepos = new Set(
    [...leads].filter(([, lead]) => options.parkedState(lead) === "settled").map(([repo]) => repo),
  );
  const byRepo = new Map<string | null, { secondMate: T | null; workers: T[] }>();
  const rest: T[] = [];
  for (const thread of threads) {
    const repo = thread.fleetRepo ?? null;
    const inTree =
      inFleet(thread) &&
      !settledRepos.has(repo) &&
      (thread.fleetRole === "worker"
        ? options.parkedState(thread) === null
        : leads.get(repo) === thread);
    if (!inTree) {
      rest.push(thread);
      continue;
    }
    const branch = byRepo.get(repo) ?? { secondMate: null, workers: [] };
    byRepo.set(repo, branch);
    if (thread.fleetRole === "worker") branch.workers.push(thread);
    else branch.secondMate = thread;
  }
  const byLaunch = (left: T, right: T) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  const branches = [...byRepo.entries()]
    .map(([repo, branch]) => ({
      repo,
      secondMate: branch.secondMate,
      workers: branch.workers.toSorted(byLaunch),
    }))
    .toSorted(
      (left, right) =>
        // Workers with no second mate sort after every crewed repository.
        Number(left.secondMate === null) - Number(right.secondMate === null) ||
        (left.repo ?? "").localeCompare(right.repo ?? ""),
    );
  return { branches, rest };
}

/** First Mate's own colour. Second mates take theirs from their project icon. */
export const FIRST_MATE_TONE_CLASS = "text-pink-600 dark:text-pink-400";

/**
 * Whether a thread is parked, and how. A parked thread lists in the Settled or
 * Snoozed section; the one fleet thread parked in the tree is a snoozed second
 * mate, drawn quietly with its wake control.
 */
export type FleetParked = "settled" | "snoozed" | null;

/**
 * The one rule for parking, shared by the fleet tree and the sections so the
 * two cannot disagree. Snooze outranks settlement until the thread wakes. A
 * server without the capability never parks a thread, because its rows would
 * have no working way back. A drag the server has not confirmed yet wins.
 */
export function resolveParkedState(
  thread: ThreadSnoozeShell & { readonly settledOverride?: string | null | undefined },
  options: {
    readonly supportsSnooze: boolean;
    readonly supportsSettlement: boolean;
    readonly now: string;
    readonly droppedInto?: "pinned" | "active" | "settled" | undefined;
  },
): FleetParked {
  if (options.droppedInto !== undefined) {
    return options.droppedInto === "settled" ? "settled" : null;
  }
  if (options.supportsSnooze && effectiveSnoozed(thread, { now: options.now })) return "snoozed";
  if (options.supportsSettlement && thread.settledOverride === "settled") return "settled";
  return null;
}

/** The section a thread outside the fleet tree lists in. */
export function sidebarSectionFor(
  thread: { readonly pinnedAt?: string | null | undefined },
  parked: FleetParked,
): "snoozed" | "settled" | "pinned" | "active" {
  return parked ?? (thread.pinnedAt != null ? "pinned" : "active");
}

/** One row of the fleet tree, in display order. */
export interface FleetRow<T> {
  readonly thread: T;
  readonly depth: 0 | 1;
  /** Whose project icon sets the row's colour: the second mate, for its workers too. */
  readonly theme: T;
  /** A worker: its second mate's colour, faded, at regular weight. */
  readonly quiet: boolean;
  readonly parked: FleetParked;
  /**
   * The pin control. A second mate's place is fixed, so it has none, except
   * the unpin a second mate pinned before the tree keeps so it can be undone.
   * A worker keeps the ordinary pin.
   */
  readonly pin: "none" | "unpin-only" | "default";
  readonly fold?: { readonly repo: string; readonly expanded: boolean } | undefined;
}

/**
 * The fleet tree as rows: each second mate, then its workers indented under it
 * unless folded. A snoozed second mate is drawn parked in its place.
 */
export function buildFleetRows<T extends FleetThread>(
  branches: readonly FleetBranch<T>[],
  options: {
    readonly isFolded: (repo: string) => boolean;
    readonly parkedState: (thread: T) => FleetParked;
  },
): FleetRow<T>[] {
  const rows: FleetRow<T>[] = [];
  for (const branch of branches) {
    const foldKey = branch.repo ?? "";
    const expanded = !options.isFolded(foldKey);
    if (branch.secondMate) {
      rows.push({
        thread: branch.secondMate,
        depth: 0,
        theme: branch.secondMate,
        quiet: false,
        parked: options.parkedState(branch.secondMate),
        pin: branch.secondMate.pinnedAt != null ? "unpin-only" : "none",
        fold: branch.workers.length > 0 ? { repo: foldKey, expanded } : undefined,
      });
      if (!expanded) continue;
    }
    for (const worker of branch.workers) {
      rows.push({
        thread: worker,
        depth: branch.secondMate ? 1 : 0,
        theme: branch.secondMate ?? worker,
        quiet: true,
        parked: options.parkedState(worker),
        pin: "default",
      });
    }
  }
  return rows;
}

/** The role word a fleet row shows before its model. */
export const FLEET_ROLE_WORDS: Record<FleetRole, string> = {
  "first-mate": "First Mate",
  "second-mate": "Second mate",
  worker: "Worker",
};
