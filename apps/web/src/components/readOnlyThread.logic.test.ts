import { describe, expect, it } from "vite-plus/test";

import { offersSessionRestart } from "./readOnlyThread.logic";

describe("offersSessionRestart", () => {
  it("is not offered on a read-only worker thread, which has no composer to send a next message", () => {
    expect(offersSessionRestart({ readOnly: true })).toBe(false);
  });

  it("is offered on an ordinary thread and on a second mate whose read-only was cleared", () => {
    expect(offersSessionRestart({})).toBe(true);
    expect(offersSessionRestart({ readOnly: false })).toBe(true);
  });
});
