import { describe, expect, it } from "vite-plus/test";

import { partitionFirstMateThreads } from "../Sidebar.logic";
import { buildFleetRows, buildFleetTree, planFirstMateSlot } from "./fleetSidebar.logic";

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
    readonly parked?: "settled" | "snoozed" | null;
  } = {},
) => ({
  id,
  fleetRole: null,
  fleetRepo: null,
  createdAt: "2026-09-24T10:00:00Z",
  updatedAt: "2026-09-24T10:00:00Z",
  archivedAt: null,
  pinnedAt: null,
  parked: null,
  ...fields,
});
type TestThread = ReturnType<typeof thread>;

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map((entry) => entry.id);

const treeFor = (threads: readonly TestThread[]) =>
  buildFleetTree(threads, { isSettled: (entry) => entry.parked === "settled" });

const rowsFor = (threads: readonly TestThread[], folded: readonly string[] = []) =>
  buildFleetRows(treeFor(threads).branches, {
    isFolded: (repo) => folded.includes(repo),
    parkedState: (entry) => entry.parked,
  });

describe("First Mate at the top", () => {
  it("keeps First Mate in the top slot whether or not it is pinned", () => {
    const unpinned = thread("fm", { fleetRole: "first-mate" });
    const { slot, rest } = partitionFirstMateThreads([thread("plain"), unpinned]);
    expect(ids(slot)).toEqual(["fm"]);
    expect(ids(rest)).toEqual(["plain"]);
  });

  it("offers Start First Mate when no First Mate thread is live", () => {
    const archived = thread("fm", { fleetRole: "first-mate", archivedAt: "2026-09-24T11:00:00Z" });
    expect(planFirstMateSlot([archived, thread("plain")])).toEqual({ kind: "start" });
  });

  it("puts the pinned First Mate on top and lists the others under it", () => {
    const older = thread("fm-old", { fleetRole: "first-mate", createdAt: "2026-09-20T00:00:00Z" });
    const pinned = thread("fm-pinned", {
      fleetRole: "first-mate",
      createdAt: "2026-09-21T00:00:00Z",
      pinnedAt: "2026-09-22T00:00:00Z",
    });
    const newest = thread("fm-new", { fleetRole: "first-mate", createdAt: "2026-09-23T00:00:00Z" });
    const plan = planFirstMateSlot([older, newest, pinned]);
    expect(plan.kind === "first-mates" ? [plan.main.id, ...ids(plan.others)] : plan).toEqual([
      "fm-pinned",
      "fm-new",
      "fm-old",
    ]);
  });

  it("puts the most recent First Mate on top when none is pinned", () => {
    const older = thread("fm-old", { fleetRole: "first-mate", createdAt: "2026-09-20T00:00:00Z" });
    const newest = thread("fm-new", { fleetRole: "first-mate", createdAt: "2026-09-23T00:00:00Z" });
    const plan = planFirstMateSlot([older, newest]);
    expect(plan.kind === "first-mates" ? [plan.main.id, ...ids(plan.others)] : plan).toEqual([
      "fm-new",
      "fm-old",
    ]);
  });

  it("lets a First Mate row be pinned and unpinned from the row", () => {
    const plan = planFirstMateSlot([thread("fm", { fleetRole: "first-mate" })]);
    expect(plan.kind === "first-mates" ? plan.pin : null).toBe("toggle");
  });
});

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
    const order = (busy: string) => ids(rowsFor(fleet(busy)).map((row) => row.thread));
    const expected = ["sm-lavish", "sm-t3", "w-old", "w-new"];
    for (const busy of ["none", "sm-t3", "sm-lavish", "w-old"]) {
      expect(order(busy)).toEqual(expected);
    }
  });

  it("passes ordinary threads through unchanged and in their order", () => {
    const plain = [thread("b"), thread("a"), thread("c")];
    const { rest } = treeFor([
      plain[0]!,
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code", parked: "snoozed" }),
      plain[1]!,
      plain[2]!,
    ]);
    expect(rest).toEqual(plain);
  });

  it("lists a settled worker with the other settled threads, not in the tree", () => {
    const settled = thread("w-settled", {
      fleetRole: "worker",
      fleetRepo: "t3code",
      parked: "settled",
    });
    // A worker whose repository has no second mate leaves the tree the same way.
    const stray = thread("stray-settled", {
      fleetRole: "worker",
      fleetRepo: "elsewhere",
      parked: "settled",
    });
    const { branches, rest } = treeFor([
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code" }),
      settled,
      stray,
    ]);
    expect(branches.map((branch) => [branch.secondMate?.id, ids(branch.workers)])).toEqual([
      ["sm", ["w"]],
    ]);
    expect(rest).toEqual([settled, stray]);
  });

  it("puts a worker back under its second mate when it is un-settled", () => {
    const fleet = (parked: "settled" | null) => [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code", parked }),
      thread("w-later", {
        fleetRole: "worker",
        fleetRepo: "t3code",
        createdAt: "2026-09-24T11:00:00Z",
      }),
    ];
    expect(ids(treeFor(fleet("settled")).rest)).toEqual(["w"]);
    expect(treeFor(fleet(null)).rest).toEqual([]);
    expect(ids(rowsFor(fleet(null)).map((row) => row.thread))).toEqual(["sm", "w", "w-later"]);
  });

  it("keeps a snoozed worker and a settled second mate in the tree", () => {
    const { branches, rest } = treeFor([
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code", parked: "settled" }),
      thread("w-snoozed", { fleetRole: "worker", fleetRepo: "t3code", parked: "snoozed" }),
    ]);
    expect(branches.map((branch) => [branch.secondMate?.id, ids(branch.workers)])).toEqual([
      ["sm", ["w-snoozed"]],
    ]);
    expect(rest).toEqual([]);
  });
});

describe("buildFleetRows", () => {
  it("keeps snoozed workers under their second mate, marked as parked", () => {
    const rows = rowsFor([
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w-snoozed", { fleetRole: "worker", fleetRepo: "t3code", parked: "snoozed" }),
    ]);
    expect(rows.map((row) => [row.thread.id, row.depth, row.parked])).toEqual([
      ["sm", 0, null],
      ["w-snoozed", 1, "snoozed"],
    ]);
  });

  it("colours each worker from its second mate's project icon", () => {
    const rows = rowsFor([
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code" }),
      thread("stray", { fleetRole: "worker", fleetRepo: "elsewhere" }),
    ]);
    expect(rows.map((row) => [row.thread.id, row.theme.id])).toEqual([
      ["sm", "sm"],
      ["w", "sm"],
      // A worker with no second mate takes its own project icon.
      ["stray", "stray"],
    ]);
  });

  it("hides a folded second mate's workers and shows them again when unfolded", () => {
    const fleet = [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code" }),
    ];
    const folded = rowsFor(fleet, ["t3code"]);
    expect(ids(folded.map((row) => row.thread))).toEqual(["sm"]);
    expect(folded[0]!.fold).toEqual({ repo: "t3code", expanded: false });
    expect(ids(rowsFor(fleet).map((row) => row.thread))).toEqual(["sm", "w"]);
  });

  it("keeps the way back for a second mate that was settled, snoozed or pinned before", () => {
    const rows = rowsFor([
      thread("sm-settled", { fleetRole: "second-mate", fleetRepo: "a", parked: "settled" }),
      thread("sm-snoozed", { fleetRole: "second-mate", fleetRepo: "b", parked: "snoozed" }),
      thread("sm-pinned", {
        fleetRole: "second-mate",
        fleetRepo: "c",
        pinnedAt: "2026-09-24T00:00:00Z",
      }),
      thread("sm-plain", { fleetRole: "second-mate", fleetRepo: "d" }),
    ]);
    expect(rows.map((row) => [row.thread.id, row.parked, row.pin])).toEqual([
      // Parked rows keep their un-settle or wake control where they stand.
      ["sm-settled", "settled", "none"],
      ["sm-snoozed", "snoozed", "none"],
      // A pinned one keeps the unpin control; an unpinned one has no pin.
      ["sm-pinned", null, "unpin-only"],
      ["sm-plain", null, "none"],
    ]);
  });
});
