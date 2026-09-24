import type { FleetThreadFields } from "@t3tools/client-runtime/fleet-threads";

/**
 * How the sidebar arranges and colours First Mate's fleet. A worker belongs to
 * the second mate whose `fleetRepo` it shares: First Mate sends the same
 * repository key for both, and nothing else links them.
 */

/** One second mate and the workers it launched. */
export interface FleetBranch<T> {
  readonly repo: string;
  /** Null when workers run in a repository that has no live second mate. */
  readonly secondMate: T | null;
  readonly workers: readonly T[];
}

type TreeThread = FleetThreadFields & {
  readonly id: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
};

/**
 * Pull second mates and their workers out of the thread list into a tree.
 * Branches sort by repository name and workers by launch order, never by
 * activity, so no fleet row moves when a thread gets busy. A second mate stays
 * in the tree whatever its settled or snoozed state; a `parked` worker (settled
 * or snoozed) leaves for the ordinary shelves like any thread. Every other
 * thread passes through to `rest` in its original order.
 */
export function buildFleetTree<T extends TreeThread>(
  threads: readonly T[],
  parked: (thread: T) => boolean = () => false,
): { readonly branches: FleetBranch<T>[]; readonly rest: T[] } {
  const byRepo = new Map<string, { secondMate: T | null; workers: T[] }>();
  const rest: T[] = [];
  for (const thread of threads) {
    const inTree =
      thread.archivedAt === null &&
      (thread.fleetRole === "second-mate" || (thread.fleetRole === "worker" && !parked(thread)));
    if (!inTree) {
      rest.push(thread);
      continue;
    }
    const repo = thread.fleetRepo ?? "";
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
        left.repo.localeCompare(right.repo),
    );
  return { branches, rest };
}

/** First Mate's text colour. Pink is First Mate's alone. */
export const FIRST_MATE_TONE = "text-pink-600 dark:text-pink-400";

/**
 * Second mate text colours: a cool set that avoids the status colours (amber
 * approval, red failure, green done), four hues far enough apart to tell at a
 * glance, in shades picked to read on the sidebar in both light and dark.
 */
export const SECOND_MATE_TONES = [
  "text-sky-700 dark:text-sky-300",
  "text-teal-700 dark:text-teal-300",
  "text-indigo-600 dark:text-indigo-300",
  "text-violet-600 dark:text-violet-300",
] as const;

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
 * The colour index of each second mate's repository. A repository starts at
 * the slot its name hashes to and moves on to the next free slot, visiting
 * repositories in name order, so the same fleet always gets the same colours
 * and adding a repository rarely moves anyone else's. Up to the palette size,
 * every second mate gets its own colour.
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

/** The role word a fleet row shows before its model. */
export function fleetRoleWord(thread: FleetThreadFields): string | null {
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
