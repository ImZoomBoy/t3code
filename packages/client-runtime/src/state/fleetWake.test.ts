import { describe, expect, it } from "vite-plus/test";

import { findLatestUserSentMessage } from "./fleetWake.ts";

describe("findLatestUserSentMessage", () => {
  it("skips a fleet wake sent after the user's own message", () => {
    const typed = { id: "typed", role: "user" as const };
    const messages = [
      typed,
      { id: "reply", role: "assistant" as const },
      { id: "wake", role: "user" as const, fleetWake: true },
    ];
    expect(findLatestUserSentMessage(messages)).toBe(typed);
  });

  it("finds nothing in a thread that holds only fleet wakes", () => {
    expect(findLatestUserSentMessage([{ role: "user" as const, fleetWake: true }])).toBeUndefined();
  });
});
