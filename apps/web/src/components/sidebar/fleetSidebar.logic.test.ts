import { describe, expect, it } from "vite-plus/test";

import { partitionFirstMateThreads } from "../Sidebar.logic";
import {
  assignSecondMateTones,
  buildFleetTree,
  fleetRoleWord,
  SECOND_MATE_TONES,
} from "./fleetSidebar.logic";

type Role = "first-mate" | "second-mate" | "worker";

const thread = (
  id: string,
  fields: {
    readonly fleetRole?: Role | null;
    readonly fleetRepo?: string | null;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly archivedAt?: string | null;
    readonly pinnedAt?: string | null;
    readonly settled?: boolean;
  } = {},
) => ({
  id,
  fleetRole: null,
  fleetRepo: null,
  createdAt: "2026-09-24T10:00:00Z",
  updatedAt: "2026-09-24T10:00:00Z",
  archivedAt: null,
  pinnedAt: null,
  settled: false,
  ...fields,
});

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map((entry) => entry.id);

describe("buildFleetTree", () => {
  it("puts each worker under the second mate that shares its fleetRepo", () => {
    const { branches } = buildFleetTree([
      thread("w-t3", { fleetRole: "worker", fleetRepo: "t3code" }),
      thread("sm-fm", { fleetRole: "second-mate", fleetRepo: "firstmate" }),
      thread("w-fm", { fleetRole: "worker", fleetRepo: "firstmate" }),
      thread("sm-t3", { fleetRole: "second-mate", fleetRepo: "t3code" }),
    ]);
    expect(branches.map((branch) => [branch.secondMate?.id, ids(branch.workers)])).toEqual([
      ["sm-fm", ["w-fm"]],
      ["sm-t3", ["w-t3"]],
    ]);
  });

  it("keeps a second mate and its workers in place when their activity changes", () => {
    const fleet = (busy: string) => [
      thread("sm-lavish", {
        fleetRole: "second-mate",
        fleetRepo: "lavish-axi",
        updatedAt: busy === "sm-lavish" ? "2026-09-24T12:00:00Z" : "2026-09-24T10:00:00Z",
      }),
      thread("sm-t3", {
        fleetRole: "second-mate",
        fleetRepo: "t3code",
        updatedAt: busy === "sm-t3" ? "2026-09-24T12:00:00Z" : "2026-09-24T10:00:00Z",
      }),
      thread("w-old", {
        fleetRole: "worker",
        fleetRepo: "t3code",
        createdAt: "2026-09-24T09:00:00Z",
        updatedAt: busy === "w-old" ? "2026-09-24T12:00:00Z" : "2026-09-24T10:00:00Z",
      }),
      thread("w-new", {
        fleetRole: "worker",
        fleetRepo: "t3code",
        createdAt: "2026-09-24T09:30:00Z",
      }),
    ];
    const order = (busy: string) =>
      buildFleetTree(fleet(busy)).branches.flatMap((branch) => [
        branch.secondMate?.id,
        ...ids(branch.workers),
      ]);
    const expected = ["sm-lavish", "sm-t3", "w-old", "w-new"];
    expect(order("none")).toEqual(expected);
    expect(order("sm-t3")).toEqual(expected);
    expect(order("sm-lavish")).toEqual(expected);
    expect(order("w-old")).toEqual(expected);
  });

  it("passes ordinary threads through unchanged and in their order", () => {
    const plain = [thread("b"), thread("a"), thread("c")];
    const { branches, rest } = buildFleetTree([
      plain[0]!,
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      plain[1]!,
      plain[2]!,
    ]);
    expect(rest).toEqual(plain);
    expect(branches).toHaveLength(1);
  });

  it("keeps a settled second mate in the tree and sends a settled worker to the shelves", () => {
    const secondMate = thread("sm", {
      fleetRole: "second-mate",
      fleetRepo: "t3code",
      settled: true,
    });
    const worker = thread("w", { fleetRole: "worker", fleetRepo: "t3code", settled: true });
    const { branches, rest } = buildFleetTree([secondMate, worker], (entry) => entry.settled);
    expect(branches.map((branch) => branch.secondMate?.id)).toEqual(["sm"]);
    expect(branches[0]!.workers).toEqual([]);
    expect(rest).toEqual([worker]);
  });

  it("lists workers without a second mate after every crewed repository", () => {
    const { branches } = buildFleetTree([
      thread("w-orphan", { fleetRole: "worker", fleetRepo: "aaa" }),
      thread("sm", { fleetRole: "second-mate", fleetRepo: "zzz" }),
    ]);
    expect(branches.map((branch) => [branch.repo, branch.secondMate?.id ?? null])).toEqual([
      ["zzz", "sm"],
      ["aaa", null],
    ]);
  });
});

describe("pinned First Mate", () => {
  it("stays at the top, above the fleet tree and every other thread", () => {
    const threads = [
      thread("plain"),
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("fm", { fleetRole: "first-mate", pinnedAt: "2026-09-24T08:00:00Z" }),
    ];
    const { slot, rest } = partitionFirstMateThreads(threads);
    expect(ids(slot)).toEqual(["fm"]);
    expect(ids(rest)).not.toContain("fm");
  });
});

describe("assignSecondMateTones", () => {
  it("gives the same repository the same colour whatever order the fleet arrives in", () => {
    const repos = ["t3code", "firstmate", "lavish-axi"];
    const first = assignSecondMateTones(repos);
    const again = assignSecondMateTones(repos.toReversed());
    for (const repo of repos) expect(again.get(repo)).toBe(first.get(repo));
  });

  it("gives every second mate its own colour up to the palette size", () => {
    const repos = Array.from({ length: SECOND_MATE_TONES.length }, (_, index) => `repo-${index}`);
    const tones = assignSecondMateTones(repos);
    expect(new Set(tones.values()).size).toBe(repos.length);
  });
});

describe("fleetRoleWord", () => {
  it("names each fleet role and nothing for an ordinary thread", () => {
    expect(fleetRoleWord({ fleetRole: "first-mate" })).toBe("First Mate");
    expect(fleetRoleWord({ fleetRole: "second-mate" })).toBe("Second mate");
    expect(fleetRoleWord({ fleetRole: "worker" })).toBe("Worker");
    expect(fleetRoleWord({ fleetRole: null })).toBeNull();
  });
});
