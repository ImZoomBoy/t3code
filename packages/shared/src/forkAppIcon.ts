/**
 * The fork's app icon as geometry, in a 1024-unit square: an orange plate, the
 * white T3 wordmark, and a navy badge in the corner carrying the fork's badge
 * letters.
 *
 * This is the one source for the icon. The web sidebar renders it as SVG
 * (`apps/web/src/components/ForkAppIcon.tsx`), and `scripts/generate-fork-icons.ts`
 * rasterises the same shapes into every PNG and ICO the desktop build ships, so
 * the taskbar icon and the sidebar icon cannot drift apart.
 *
 * Badge letters are strokes rather than font text, so both renderers draw the
 * same letters without depending on a system font. Each stroke is drawn with a
 * round cap and a round join at {@link FORK_BADGE_LETTER_STROKE_WIDTH}.
 */

import { resolveForkBuildIdentity } from "./forkBuild.ts";

/** Width and height of the icon's coordinate space. */
export const FORK_APP_ICON_SIZE = 1024;

export const FORK_APP_ICON_COLORS = {
  plate: "#C2410C",
  artwork: "#FFFFFF",
  badge: "#0B1220",
} as const;

/** Corner radius of the plate, which fills the whole square. */
export const FORK_APP_ICON_PLATE_RADIUS = 260;

/** The badge: a white ring with a navy disc inside it. */
export const FORK_APP_ICON_BADGE = {
  cx: 790,
  cy: 790,
  ringRadius: 200,
  fillRadius: 174,
} as const;

/** Upstream's T3 wordmark outline (`apps/web/src/components/T3Wordmark.tsx`), in its own units. */
const WORDMARK_PATH =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";
const WORDMARK_BOUNDS = { x: 15.5309, y: 37, width: 94.3941, height: 56.96 } as const;
/** The box the wordmark is fitted into, centred, keeping its proportions. */
const WORDMARK_BOX = { x: 120, y: 170, width: 620, height: 374 } as const;

const wordmarkScale = Math.min(
  WORDMARK_BOX.width / WORDMARK_BOUNDS.width,
  WORDMARK_BOX.height / WORDMARK_BOUNDS.height,
);

/** The wordmark path and the transform that places it: `translate(x y) scale(scale)`. */
export const FORK_APP_ICON_WORDMARK = {
  path: WORDMARK_PATH,
  scale: wordmarkScale,
  x:
    WORDMARK_BOX.x +
    (WORDMARK_BOX.width - WORDMARK_BOUNDS.width * wordmarkScale) / 2 -
    WORDMARK_BOUNDS.x * wordmarkScale,
  y:
    WORDMARK_BOX.y +
    (WORDMARK_BOX.height - WORDMARK_BOUNDS.height * wordmarkScale) / 2 -
    WORDMARK_BOUNDS.y * wordmarkScale,
} as const;

export const FORK_BADGE_LETTER_STROKE_WIDTH = 28;
const LETTER_HEIGHT = 132;
const LETTER_GAP = 20;

type Point = readonly [x: number, y: number];

/** One badge letter: its outer width and its strokes, relative to its top-left corner. */
interface BadgeGlyph {
  readonly width: number;
  readonly strokes: ReadonlyArray<ReadonlyArray<Point>>;
}

const half = FORK_BADGE_LETTER_STROKE_WIDTH / 2;

/** Points along an ellipse, from one angle to another in degrees, y pointing up. */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  const steps = Math.ceil(Math.abs(to - from) / 5);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = ((from + ((to - from) * index) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(angle), cy - ry * Math.sin(angle)] as const;
  });
}

function glyphS(): BadgeGlyph {
  const width = 92;
  const rx = (width - FORK_BADGE_LETTER_STROKE_WIDTH) / 2;
  const ry = (LETTER_HEIGHT - FORK_BADGE_LETTER_STROKE_WIDTH) / 4;
  const cx = width / 2;
  // Two stacked bowls: the upper one runs anticlockwise from its right terminal to
  // the middle, the lower one clockwise from the middle to its left terminal.
  const upper = arc(cx, half + ry, rx, ry, 35, 270);
  const lower = arc(cx, half + ry * 3, rx, ry, 90, -145);
  return { width, strokes: [[...upper, ...lower.slice(1)]] };
}

function glyphI(): BadgeGlyph {
  return {
    width: FORK_BADGE_LETTER_STROKE_WIDTH,
    strokes: [
      [
        [half, half],
        [half, LETTER_HEIGHT - half],
      ],
    ],
  };
}

const BADGE_GLYPHS: Readonly<Record<string, () => BadgeGlyph>> = { S: glyphS, I: glyphI };

/**
 * The strokes that spell `label` on the badge, centred on it, in icon units.
 * Throws for a letter with no glyph, so a new badge label fails the icon tests
 * instead of shipping a blank badge.
 */
export function forkBadgeLetterStrokes(
  label: string = resolveForkBuildIdentity().badgeLabel,
): ReadonlyArray<ReadonlyArray<Point>> {
  const glyphs = [...label].map((letter) => {
    const glyph = BADGE_GLYPHS[letter];
    if (!glyph) throw new Error(`The fork badge has no glyph for "${letter}".`);
    return glyph();
  });
  const totalWidth =
    glyphs.reduce((sum, glyph) => sum + glyph.width, 0) + LETTER_GAP * (glyphs.length - 1);

  let left = FORK_APP_ICON_BADGE.cx - totalWidth / 2;
  const top = FORK_APP_ICON_BADGE.cy - LETTER_HEIGHT / 2;
  return glyphs.flatMap((glyph) => {
    const x = left;
    left += glyph.width + LETTER_GAP;
    return glyph.strokes.map((stroke) => stroke.map(([px, py]) => [x + px, top + py] as const));
  });
}
