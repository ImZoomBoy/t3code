import { describe, expect, it } from "vite-plus/test";

import { fleetRoleLabel, formatModelDisplayName, threadDisplayTitle } from "./fleetThreads.ts";

describe("fleetRoleLabel", () => {
  it("names each fleet role", () => {
    expect(fleetRoleLabel({ fleetRole: "first-mate", fleetRepo: null })).toBe("First Mate");
    expect(fleetRoleLabel({ fleetRole: "second-mate", fleetRepo: "t3code" })).toBe(
      "Second mate - t3code",
    );
    expect(fleetRoleLabel({ fleetRole: "worker", fleetRepo: "t3code" })).toBe("Worker");
  });

  it("falls back to the bare role when a second mate has no repository", () => {
    expect(fleetRoleLabel({ fleetRole: "second-mate", fleetRepo: null })).toBe("Second mate");
  });

  it("gives an ordinary thread no label", () => {
    expect(fleetRoleLabel({})).toBeNull();
    expect(fleetRoleLabel({ fleetRole: null })).toBeNull();
  });
});

describe("threadDisplayTitle", () => {
  it("always calls the First Mate thread First Mate", () => {
    expect(
      threadDisplayTitle({ title: "fm/claude-code-hooks opus-5 high", fleetRole: "first-mate" }),
    ).toBe("First Mate");
  });

  it("drops a role tag and a model with effort from an older fleet title", () => {
    expect(
      threadDisplayTitle({ title: "[crewmate] feat/wake-on-task-filed opus-5-5[1m] medium" }),
    ).toBe("feat/wake-on-task-filed");
    expect(threadDisplayTitle({ title: "fix/146-fold-repair opus-5 high" })).toBe(
      "fix/146-fold-repair",
    );
    expect(threadDisplayTitle({ title: "[first mate] survey claude-sonnet-5" })).toBe("survey");
  });

  it("leaves ordinary titles alone", () => {
    expect(threadDisplayTitle({ title: "Move to opus" })).toBe("Move to opus");
    expect(threadDisplayTitle({ title: "[WIP] sidebar polish" })).toBe("[WIP] sidebar polish");
    expect(threadDisplayTitle({ title: "Make effort high" })).toBe("Make effort high");
  });

  it("keeps a title that is only a model", () => {
    expect(threadDisplayTitle({ title: "opus-5-5" })).toBe("opus-5-5");
  });
});

describe("formatModelDisplayName", () => {
  it("reads Claude ids as family and version", () => {
    expect(formatModelDisplayName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(formatModelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(formatModelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(formatModelDisplayName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(formatModelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(formatModelDisplayName("opus")).toBe("Opus");
  });

  it("uses the catalog name for other ids, or the id without its suffix", () => {
    expect(formatModelDisplayName("gpt-6-sol", "GPT-6 Sol")).toBe("GPT-6 Sol");
    expect(formatModelDisplayName("gpt-6-sol")).toBe("gpt-6-sol");
    expect(formatModelDisplayName("some-model[1m]")).toBe("some-model");
  });

  it("prefers its own Claude name over a longer catalog name", () => {
    expect(formatModelDisplayName("claude-opus-5-5[1m]", "Claude Opus 5.5")).toBe("Opus 5.5");
  });
});
