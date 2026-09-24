import { describe, expect, it } from "vite-plus/test";

import { deriveProjectIdentity } from "../../projectIdentity";
import { chooseFleetTone, fleetToneStyle } from "./fleetTone.logic";

/** A square RGBA image: `paint` gives each pixel's colour, or null for transparent. */
const image = (
  size: number,
  paint: (x: number, y: number) => readonly [number, number, number] | null,
) => {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = paint(x, y);
      if (colour === null) continue;
      pixels.set([...colour, 255], (y * size + x) * 4);
    }
  }
  return pixels;
};

describe("chooseFleetTone", () => {
  it("takes a monogram badge's own colour", () => {
    const tone = chooseFleetTone({ kind: "badge", color: "lime" }, "firstmate");
    expect(tone).toEqual({ kind: "badge", color: "lime" });
    expect(fleetToneStyle(tone).className).toBe("text-lime-600 dark:text-lime-400");
  });

  it("reads a logo's main colour and keeps its hue in light and dark", () => {
    // A blue tile with white lettering and transparent corners, like the T3 logo.
    const logo = image(16, (x, y) => {
      if ((x < 2 || x > 13) && (y < 2 || y > 13)) return null;
      if (y >= 6 && y <= 9 && x >= 4 && x <= 11) return [255, 255, 255];
      return [37, 99, 235];
    });
    const tone = chooseFleetTone({ kind: "image", pixels: logo }, "t3code");
    expect(tone.kind).toBe("image");
    if (tone.kind !== "image") return;
    expect(tone.hue).toBeGreaterThan(250);
    expect(tone.hue).toBeLessThan(275);
    const { style } = fleetToneStyle(tone);
    const light = style?.["--fleet-tone-light"];
    const dark = style?.["--fleet-tone-dark"];
    // Only the lightness differs between the two themes.
    expect(light?.replace(/^oklch\([\d.]+ /, "")).toBe(dark?.replace(/^oklch\([\d.]+ /, ""));
    expect(light).not.toBe(dark);
  });

  it("falls back to the repository's stable colour when the logo has no colour", () => {
    const greyLogo = image(8, (x) => (x < 4 ? [20, 20, 20] : [240, 240, 240]));
    const expected = { kind: "fallback", color: deriveProjectIdentity("lavish-axi").color };
    expect(chooseFleetTone({ kind: "image", pixels: greyLogo }, "lavish-axi")).toMatchObject(
      expected,
    );
    // An image the browser would not let us read, and an emoji, fall back the same way.
    expect(chooseFleetTone({ kind: "image", pixels: null }, "lavish-axi")).toMatchObject(expected);
    expect(chooseFleetTone({ kind: "none" }, "lavish-axi")).toMatchObject(expected);
  });
});
