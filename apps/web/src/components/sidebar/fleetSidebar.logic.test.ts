import { describe, expect, it } from "vite-plus/test";

import { partitionFirstMateThreads } from "../Sidebar.logic";
import {
  buildFleetRows,
  buildFleetTree,
  planFirstMateSlot,
  resolveParkedState,
  sidebarSectionFor,
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
  buildFleetTree(threads, { parkedState: (entry) => entry.parked });

/** The section each thread outside the tree lists in, as the sidebar sorts them. */
const sectionsOutsideTree = (threads: readonly TestThread[]) =>
  treeFor(threads).rest.map((entry) => [entry.id, sidebarSectionFor(entry, entry.parked)]);

const branchesOf = (threads: readonly TestThread[]) =>
  treeFor(threads).branches.map((branch) => [branch.secondMate?.id, ids(branch.workers)]);

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
    const { branches } = treeFor([
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
      thread("w", { fleetRole: "worker", fleetRepo: "t3code" }),
      plain[1]!,
      plain[2]!,
    ]);
    expect(rest).toEqual(plain);
  });

  it("lists a settled worker in Settled, not in the tree", () => {
    const fleet = [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code" }),
      thread("w-settled", { fleetRole: "worker", fleetRepo: "t3code", parked: "settled" }),
      // A worker whose repository has no second mate leaves the tree the same way.
      thread("stray-settled", { fleetRole: "worker", fleetRepo: "elsewhere", parked: "settled" }),
    ];
    expect(branchesOf(fleet)).toEqual([["sm", ["w"]]]);
    expect(sectionsOutsideTree(fleet)).toEqual([
      ["w-settled", "settled"],
      ["stray-settled", "settled"],
    ]);
  });

  it("lists a snoozed worker in Snoozed, not in the tree", () => {
    const fleet = [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w-snoozed", { fleetRole: "worker", fleetRepo: "t3code", parked: "snoozed" }),
    ];
    expect(branchesOf(fleet)).toEqual([["sm", []]]);
    expect(sectionsOutsideTree(fleet)).toEqual([["w-snoozed", "snoozed"]]);
  });

  it("puts a worker back under its second mate when it is un-settled or woken", () => {
    const fleet = (parked: "settled" | "snoozed" | null) => [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code", parked }),
      thread("w-later", {
        fleetRole: "worker",
        fleetRepo: "t3code",
        createdAt: "2026-09-24T11:00:00Z",
      }),
    ];
    for (const parked of ["settled", "snoozed"] as const) {
      expect(ids(treeFor(fleet(parked)).rest)).toEqual(["w"]);
    }
    expect(treeFor(fleet(null)).rest).toEqual([]);
    expect(ids(rowsFor(fleet(null)).map((row) => row.thread))).toEqual(["sm", "w", "w-later"]);
  });

  it("takes every worker out of the tree with a settled second mate, each to its own section", () => {
    const fleet = [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code", parked: "settled" }),
      thread("w-live", { fleetRole: "worker", fleetRepo: "t3code" }),
      thread("w-pinned", {
        fleetRole: "worker",
        fleetRepo: "t3code",
        pinnedAt: "2026-09-24T00:00:00Z",
      }),
      thread("w-settled", { fleetRole: "worker", fleetRepo: "t3code", parked: "settled" }),
      thread("w-snoozed", { fleetRole: "worker", fleetRepo: "t3code", parked: "snoozed" }),
      thread("other-sm", { fleetRole: "second-mate", fleetRepo: "firstmate" }),
    ];
    expect(branchesOf(fleet)).toEqual([["other-sm", []]]);
    expect(sectionsOutsideTree(fleet)).toEqual([
      ["sm", "settled"],
      ["w-live", "active"],
      ["w-pinned", "pinned"],
      ["w-settled", "settled"],
      ["w-snoozed", "snoozed"],
    ]);
  });

  it("brings a second mate and its live workers back when the second mate is un-settled", () => {
    const fleet = (parked: "settled" | null) => [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code", parked }),
      thread("w-live", { fleetRole: "worker", fleetRepo: "t3code" }),
      thread("w-settled", { fleetRole: "worker", fleetRepo: "t3code", parked: "settled" }),
    ];
    expect(branchesOf(fleet("settled"))).toEqual([]);
    expect(branchesOf(fleet(null))).toEqual([["sm", ["w-live"]]]);
    expect(sectionsOutsideTree(fleet(null))).toEqual([["w-settled", "settled"]]);
  });

  it("keeps a snoozed second mate in the tree with its live workers", () => {
    const fleet = [
      thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code", parked: "snoozed" }),
      thread("w", { fleetRole: "worker", fleetRepo: "t3code" }),
    ];
    expect(branchesOf(fleet)).toEqual([["sm", ["w"]]]);
    expect(rowsFor(fleet).map((row) => [row.thread.id, row.parked])).toEqual([
      ["sm", "snoozed"],
      ["w", null],
    ]);
  });
});

describe("resolveParkedState", () => {
  const now = "2026-09-24T12:00:00Z";
  const shell = (fields: {
    readonly settledOverride?: "settled" | null;
    readonly snoozedUntil?: string | null;
  }) => ({
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    settledOverride: null,
    ...fields,
  });
  const both = { supportsSnooze: true, supportsSettlement: true, now };

  it("puts snooze ahead of settlement until the thread wakes", () => {
    const thread = shell({ settledOverride: "settled", snoozedUntil: "2026-09-24T13:00:00Z" });
    expect(resolveParkedState(thread, both)).toBe("snoozed");
    expect(resolveParkedState(thread, { ...both, now: "2026-09-24T14:00:00Z" })).toBe("settled");
  });

  it("never parks a thread on a server without the capability", () => {
    const thread = shell({ settledOverride: "settled", snoozedUntil: "2026-09-24T13:00:00Z" });
    expect(
      resolveParkedState(thread, { supportsSnooze: false, supportsSettlement: false, now }),
    ).toBe(null);
  });

  it("follows a drag before the server confirms it", () => {
    const settled = shell({ settledOverride: "settled" });
    expect(resolveParkedState(settled, { ...both, droppedInto: "active" })).toBe(null);
    expect(resolveParkedState(settled, { ...both, droppedInto: "pinned" })).toBe(null);
    expect(resolveParkedState(shell({}), { ...both, droppedInto: "settled" })).toBe("settled");
  });

  it("puts a settled worker dragged into Active back in the tree at once", () => {
    const fleet = [
      { ...thread("sm", { fleetRole: "second-mate", fleetRepo: "t3code" }), ...shell({}) },
      {
        ...thread("w", { fleetRole: "worker", fleetRepo: "t3code" }),
        ...shell({ settledOverride: "settled" }),
      },
    ];
    const tree = (droppedInto?: "active") =>
      buildFleetTree(fleet, {
        parkedState: (entry) =>
          resolveParkedState(entry, {
            ...both,
            droppedInto: entry.id === "w" ? droppedInto : undefined,
          }),
      });
    expect(ids(tree().rest)).toEqual(["w"]);
    expect(tree("active").branches.map((branch) => ids(branch.workers))).toEqual([["w"]]);
  });
});

describe("buildFleetRows", () => {
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

  it("keeps the way back for a second mate that was snoozed or pinned before", () => {
    const rows = rowsFor([
      thread("sm-snoozed", { fleetRole: "second-mate", fleetRepo: "b", parked: "snoozed" }),
      thread("sm-pinned", {
        fleetRole: "second-mate",
        fleetRepo: "c",
        pinnedAt: "2026-09-24T00:00:00Z",
      }),
      thread("sm-plain", { fleetRole: "second-mate", fleetRepo: "d" }),
    ]);
    expect(rows.map((row) => [row.thread.id, row.parked, row.pin])).toEqual([
      // A snoozed one keeps its wake control where it stands.
      ["sm-snoozed", "snoozed", "none"],
      // A pinned one keeps the unpin control; an unpinned one has no pin.
      ["sm-pinned", null, "unpin-only"],
      ["sm-plain", null, "none"],
    ]);
  });
});
