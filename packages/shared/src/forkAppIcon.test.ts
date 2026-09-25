import { describe, expect, it } from "vite-plus/test";

import {
  FORK_APP_ICON_BADGE,
  FORK_BADGE_LETTER_STROKE_WIDTH,
  forkBadgeLetterStrokes,
} from "./forkAppIcon.ts";

describe("forkBadgeLetterStrokes", () => {
  it("spells the fork's badge label inside the badge disc", () => {
    const strokes = forkBadgeLetterStrokes();
    expect(strokes.length).toBeGreaterThan(0);

    const reach = Math.max(
      ...strokes
        .flat()
        .map(([x, y]) => Math.hypot(x - FORK_APP_ICON_BADGE.cx, y - FORK_APP_ICON_BADGE.cy)),
    );
    expect(reach + FORK_BADGE_LETTER_STROKE_WIDTH / 2).toBeLessThan(FORK_APP_ICON_BADGE.fillRadius);
  });

  it("refuses a letter it has no glyph for", () => {
    expect(() => forkBadgeLetterStrokes("SQ")).toThrow('no glyph for "Q"');
  });
});
