import type { FleetRole } from "@t3tools/contracts";
import type { FleetThreadFields } from "@t3tools/client-runtime/fleet-threads";

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
 * activity, so no fleet row moves when a thread gets busy. Settled and snoozed
 * fleet threads stay in the tree too. Every other thread passes through to
 * `rest` in its original order.
 */
export function buildFleetTree<T extends FleetThread>(
  threads: readonly T[],
): { readonly branches: FleetBranch<T>[]; readonly rest: T[] } {
  const byRepo = new Map<string | null, { secondMate: T | null; workers: T[] }>();
  const rest: T[] = [];
  for (const thread of threads) {
    const inTree =
      thread.archivedAt === null &&
      (thread.fleetRole === "second-mate" || thread.fleetRole === "worker");
    if (!inTree) {
      rest.push(thread);
      continue;
    }
    const repo = thread.fleetRepo ?? null;
    const branch = byRepo.get(repo) ?? { secondMate: null, workers: [] };
    byRepo.set(repo, branch);
    if (thread.fleetRole === "worker") {
      branch.workers.push(thread);
    } else if (branch.secondMate === null) {
      branch.secondMate = thread;
    } else {
      // One second mate per repository; the newer one leads, an older one
      // lists as an ordinary thread rather than vanishing.
      const [older, newer] =
        thread.createdAt > branch.secondMate.createdAt
          ? [branch.secondMate, thread]
          : [thread, branch.secondMate];
      rest.push(older);
      branch.secondMate = newer;
    }
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

/** A text colour a fleet row can wear. */
export type FleetTone =
  | "first-mate"
  | "sky"
  | "teal"
  | "indigo"
  | "violet"
  | "lime"
  | "fuchsia"
  | "plain";

/**
 * Colour classes per tone. First Mate's pink is its alone. The second mate
 * colours keep clear of the status colours (amber approval, red failure, green
 * done) and of each other, in shades picked to read in light and dark.
 */
export const FLEET_TONE_CLASSES: Record<FleetTone, string> = {
  "first-mate": "text-pink-600 dark:text-pink-400",
  sky: "text-sky-700 dark:text-sky-300",
  teal: "text-teal-700 dark:text-teal-300",
  indigo: "text-indigo-600 dark:text-indigo-300",
  violet: "text-violet-600 dark:text-violet-300",
  lime: "text-lime-700 dark:text-lime-300",
  fuchsia: "text-fuchsia-700 dark:text-fuchsia-300",
  plain: "text-muted-foreground",
};

export const SECOND_MATE_TONES = [
  "sky",
  "teal",
  "indigo",
  "violet",
  "lime",
  "fuchsia",
] as const satisfies readonly FleetTone[];

function hashRepo(repo: string): number {
  // FNV-1a: small, fast, and the same on every client.
  let hash = 0x811c9dc5;
  for (let index = 0; index < repo.length; index += 1) {
    hash ^= repo.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Each second mate's colour index. A repository starts at the slot its name
 * hashes to and moves on to the next free one, visiting repositories in name
 * order, so the same fleet always gets the same colours and adding a
 * repository rarely moves anyone else's. Up to the palette size, every second
 * mate gets its own colour.
 */
export function assignSecondMateTones(repos: readonly string[]): ReadonlyMap<string, number> {
  const size = SECOND_MATE_TONES.length;
  const assigned = new Map<string, number>();
  const used = new Set<number>();
  for (const repo of [...new Set(repos)].toSorted()) {
    let slot = hashRepo(repo) % size;
    for (let tries = 0; tries < size && used.has(slot); tries += 1) slot = (slot + 1) % size;
    used.add(slot);
    assigned.set(repo, slot);
  }
  return assigned;
}

/** A settled or snoozed fleet thread keeps its place, drawn quietly with its way back. */
export type FleetParked = "settled" | "snoozed" | null;

/** One row of the fleet tree, in display order. */
export interface FleetRow<T> {
  readonly thread: T;
  readonly depth: 0 | 1;
  readonly tone: FleetTone;
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
 * The fleet tree as rows: each second mate in its colour, then its workers
 * indented under it unless folded. Parked threads stay in their place.
 */
export function buildFleetRows<T extends FleetThread>(
  branches: readonly FleetBranch<T>[],
  options: {
    readonly isFolded: (repo: string) => boolean;
    readonly parkedState: (thread: T) => FleetParked;
  },
): FleetRow<T>[] {
  const tones = assignSecondMateTones(
    branches.flatMap((branch) => (branch.secondMate && branch.repo !== null ? [branch.repo] : [])),
  );
  const rows: FleetRow<T>[] = [];
  for (const branch of branches) {
    const toneIndex = branch.repo === null ? undefined : tones.get(branch.repo);
    const tone: FleetTone = toneIndex === undefined ? "plain" : SECOND_MATE_TONES[toneIndex]!;
    const foldKey = branch.repo ?? "";
    const expanded = !options.isFolded(foldKey);
    if (branch.secondMate) {
      rows.push({
        thread: branch.secondMate,
        depth: 0,
        tone,
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
        tone,
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
