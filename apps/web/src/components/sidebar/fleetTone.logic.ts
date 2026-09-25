import type { ProjectIconColor } from "@t3tools/contracts";

import { deriveProjectIdentity } from "../../projectIdentity";
import { projectIconColorClassName } from "../../projectIconColors";

/**
 * A second mate's colour comes from its project icon as the sidebar shows it,
 * so a venture reads in its own colour. Its workers wear the same colour,
 * quieter. First Mate keeps its own pink and never comes through here.
 */

/** What the project icon offers to take a colour from. */
export type FleetIconSource =
  /** A monogram badge or a coloured Lucide icon: its chosen colour. */
  | { readonly kind: "badge"; readonly color: ProjectIconColor }
  /** A project image, as RGBA bytes, or null when the browser would not let us read it. */
  | { readonly kind: "image"; readonly pixels: ArrayLike<number> | null }
  /** An icon with no colour to take, such as an emoji. */
  | { readonly kind: "none" };

export type FleetToneChoice =
  | { readonly kind: "badge"; readonly color: ProjectIconColor }
  /** An image's main colour, as OKLCH hue in degrees and chroma. */
  | { readonly kind: "image"; readonly hue: number; readonly chroma: number }
  /** No usable colour in the icon: a stable colour from the repository name. */
  | { readonly kind: "fallback"; readonly color: ProjectIconColor };

export function chooseFleetTone(source: FleetIconSource, repo: string): FleetToneChoice {
  if (source.kind === "badge") return { kind: "badge", color: source.color };
  const main = source.kind === "image" && source.pixels ? mainColorOfPixels(source.pixels) : null;
  if (main) return { kind: "image", ...main };
  return { kind: "fallback", color: deriveProjectIdentity(repo).color };
}

// Text lightness in OKLCH for each theme. Hue and chroma stay the image's own.
const LIGHT_THEME_LIGHTNESS = 0.52;
const DARK_THEME_LIGHTNESS = 0.8;

/** Classes, and for an image the colour variables they read, for text in this tone. */
export function fleetToneStyle(tone: FleetToneChoice): {
  readonly className: string;
  readonly style?: Readonly<Record<"--fleet-tone-light" | "--fleet-tone-dark", string>>;
} {
  if (tone.kind !== "image") return { className: projectIconColorClassName(tone.color) };
  const hueAndChroma = `${tone.chroma.toFixed(3)} ${tone.hue.toFixed(1)})`;
  return {
    className: "text-[color:var(--fleet-tone-light)] dark:text-[color:var(--fleet-tone-dark)]",
    style: {
      "--fleet-tone-light": `oklch(${LIGHT_THEME_LIGHTNESS} ${hueAndChroma}`,
      "--fleet-tone-dark": `oklch(${DARK_THEME_LIGHTNESS} ${hueAndChroma}`,
    },
  };
}

// Pixels below this chroma read as white, black or grey and carry no colour.
const MIN_CHROMA = 0.05;
// A logo whose coloured pixels are rarer than this is a grey logo with specks.
const MIN_COLOURED_SHARE = 0.1;
const HUE_BINS = 24;

function toLinear(channel: number) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** sRGB bytes to OKLab a and b. */
function oklabAB(red: number, green: number, blue: number) {
  const r = toLinear(red);
  const g = toLinear(green);
  const b = toLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * The main colour of an RGBA image: the hue that covers the most coloured
 * area, weighted by how strong the colour is. Null when the image has no
 * real colour.
 */
function mainColorOfPixels(
  pixels: ArrayLike<number>,
): { readonly hue: number; readonly chroma: number } | null {
  const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, a: 0, b: 0, count: 0 }));
  let opaque = 0;
  let coloured = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    opaque += 1;
    const { a, b } = oklabAB(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
    const chroma = Math.hypot(a, b);
    if (chroma < MIN_CHROMA) continue;
    coloured += 1;
    const hue = (Math.atan2(b, a) * 180) / Math.PI + 360;
    const bin = bins[Math.floor(((hue % 360) / 360) * HUE_BINS) % HUE_BINS]!;
    bin.weight += chroma;
    bin.a += a;
    bin.b += b;
    bin.count += 1;
  }
  if (opaque === 0 || coloured / opaque < MIN_COLOURED_SHARE) return null;
  const main = bins.reduce((best, bin) => (bin.weight > best.weight ? bin : best));
  const a = main.a / main.count;
  const b = main.b / main.count;
  return {
    hue: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
    chroma: Math.hypot(a, b),
  };
}
