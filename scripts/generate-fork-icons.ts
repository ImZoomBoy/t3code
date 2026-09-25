#!/usr/bin/env node

/**
 * Regenerates this fork's app icons so it is distinguishable from an official
 * T3 Code install in the taskbar and in Alt-Tab (#59), and matches the icon in
 * the sidebar header.
 *
 * Every file is rasterised from the icon geometry in
 * `packages/shared/src/forkAppIcon.ts`, the same shapes the sidebar renders as
 * SVG. Each size is drawn directly at its own resolution. Below
 * {@link BADGE_LETTERS_MIN_SIZE} the badge letters cannot resolve, so the badge
 * is drawn plain.
 *
 *   node scripts/generate-fork-icons.ts
 *
 * `generate-fork-icons.test.ts` re-runs the generator and compares it against
 * the committed bytes, so the assets cannot drift away from this file.
 *
 * Outputs (all committed):
 *   assets/fork/fork-universal-1024.png   Linux and Windows master
 *   assets/fork/fork-macos-1024.png       macOS master, inset to Apple's icon grid
 *   assets/fork/fork-windows.ico          16, 24, 32, 48, 64, 128, 256
 *   assets/fork/fork-web-*                favicons and the apple touch icon
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  FORK_APP_ICON_BADGE,
  FORK_APP_ICON_COLORS,
  FORK_APP_ICON_PLATE_RADIUS,
  FORK_APP_ICON_SIZE,
  FORK_APP_ICON_WORDMARK,
  FORK_BADGE_LETTER_STROKE_WIDTH,
  forkBadgeLetterStrokes,
} from "@t3tools/shared/forkAppIcon";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";
import { PNG } from "pngjs";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

/** Smallest rendition that carries the badge letters; smaller ones get a plain badge. */
export const BADGE_LETTERS_MIN_SIZE = 48;

/** Sizes the hosted web build asks for: two favicons and the apple touch icon. */
const WEB_ICON_SIZES = [16, 32, 180] as const;

/** Upstream's macOS master keeps Apple's grid: an 824px plate inset 100px in 1024. */
const MACOS_PLATE_INSET = 100 / 1024;

/** Sub-scanlines per pixel row. Coverage along a scanline is exact. */
const SUBSCANLINES = 16;

/** Line segments per curve or arc when flattening outlines. */
const CURVE_SEGMENTS = 32;
const CIRCLE_SEGMENTS = 256;

type Point = readonly [x: number, y: number];
type Polygon = ReadonlyArray<Point>;

interface Layer {
  readonly polygons: ReadonlyArray<Polygon>;
  readonly color: string;
}

const circle = (cx: number, cy: number, r: number, segments = CIRCLE_SEGMENTS): Polygon =>
  Array.from({ length: segments }, (_, index) => {
    const angle = (2 * Math.PI * index) / segments;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
  });

function roundedSquare(size: number, radius: number): Polygon {
  const corners: ReadonlyArray<readonly [number, number, number]> = [
    [size - radius, size - radius, 0],
    [radius, size - radius, 90],
    [radius, radius, 180],
    [size - radius, radius, 270],
  ];
  return corners.flatMap(([cx, cy, start]) =>
    Array.from({ length: CURVE_SEGMENTS + 1 }, (_, index) => {
      const angle = ((start + (90 * index) / CURVE_SEGMENTS) * Math.PI) / 180;
      return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
    }),
  );
}

/** Flattens an SVG path made of absolute M, L, H, V, C and Z commands. */
function flattenPath(d: string): Polygon[] {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const polygons: Point[][] = [];
  let current: Point[] = [];
  let x = 0;
  let y = 0;
  let index = 0;
  const next = () => Number(tokens[index++]);

  while (index < tokens.length) {
    const command = tokens[index++]!;
    switch (command) {
      case "M":
        if (current.length > 0) polygons.push(current);
        x = next();
        y = next();
        current = [[x, y]];
        break;
      case "L":
        x = next();
        y = next();
        current.push([x, y]);
        break;
      case "H":
        x = next();
        current.push([x, y]);
        break;
      case "V":
        y = next();
        current.push([x, y]);
        break;
      case "C": {
        const [x1, y1, x2, y2, x3, y3] = [next(), next(), next(), next(), next(), next()];
        for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
          const t = step / CURVE_SEGMENTS;
          const u = 1 - t;
          current.push([
            u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          ]);
        }
        x = x3;
        y = y3;
        break;
      }
      case "Z":
        if (current.length > 0) polygons.push(current);
        current = [];
        break;
      default:
        throw new Error(`Unsupported path command "${command}" in the fork icon wordmark.`);
    }
  }
  if (current.length > 0) polygons.push(current);
  return polygons;
}

const signedArea = (polygon: Polygon) =>
  polygon.reduce((sum, [x0, y0], index) => {
    const [x1, y1] = polygon[(index + 1) % polygon.length]!;
    return sum + x0 * y1 - x1 * y0;
  }, 0);

/** One winding direction for every piece, so overlapping pieces union under nonzero fill. */
const clockwise = (polygon: Polygon): Polygon =>
  signedArea(polygon) < 0 ? [...polygon].toReversed() : polygon;

/**
 * A polyline stroked with round caps and joins, as SVG draws it: a rectangle per
 * segment and a disc at every point.
 */
function strokePolyline(points: ReadonlyArray<Point>, width: number): Polygon[] {
  const half = width / 2;
  const discs = points.map(([x, y]) => clockwise(circle(x, y, half, 64)));
  const segments = points.slice(1).flatMap(([x1, y1], index) => {
    const [x0, y0] = points[index]!;
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length === 0) return [];
    const nx = (-(y1 - y0) / length) * half;
    const ny = ((x1 - x0) / length) * half;
    return [
      clockwise([
        [x0 + nx, y0 + ny],
        [x1 + nx, y1 + ny],
        [x1 - nx, y1 - ny],
        [x0 - nx, y0 - ny],
      ]),
    ];
  });
  return [...segments, ...discs];
}

/** The icon's layers, bottom to top, in icon units. */
function iconLayers(withBadgeLetters: boolean): ReadonlyArray<Layer> {
  const { cx, cy, ringRadius, fillRadius } = FORK_APP_ICON_BADGE;
  const wordmark = flattenPath(FORK_APP_ICON_WORDMARK.path).map((polygon) =>
    polygon.map(
      ([x, y]) =>
        [
          FORK_APP_ICON_WORDMARK.x + x * FORK_APP_ICON_WORDMARK.scale,
          FORK_APP_ICON_WORDMARK.y + y * FORK_APP_ICON_WORDMARK.scale,
        ] as const,
    ),
  );
  const layers: Layer[] = [
    {
      polygons: [roundedSquare(FORK_APP_ICON_SIZE, FORK_APP_ICON_PLATE_RADIUS)],
      color: FORK_APP_ICON_COLORS.plate,
    },
    { polygons: wordmark, color: FORK_APP_ICON_COLORS.artwork },
    { polygons: [circle(cx, cy, ringRadius)], color: FORK_APP_ICON_COLORS.artwork },
    { polygons: [circle(cx, cy, fillRadius)], color: FORK_APP_ICON_COLORS.badge },
  ];
  if (withBadgeLetters) {
    layers.push({
      polygons: forkBadgeLetterStrokes().flatMap((stroke) =>
        strokePolyline(stroke, FORK_BADGE_LETTER_STROKE_WIDTH),
      ),
      color: FORK_APP_ICON_COLORS.artwork,
    });
  }
  return layers;
}

/** Nonzero-fill coverage of polygons already in pixel units, one float per pixel. */
function coverage(polygons: ReadonlyArray<Polygon>, size: number): Float64Array {
  const cover = new Float64Array(size * size);
  const edges = polygons.flatMap((polygon) =>
    polygon.flatMap(([x0, y0], index) => {
      const [x1, y1] = polygon[(index + 1) % polygon.length]!;
      if (y0 === y1) return [];
      return [
        { x0, y0, x1, y1, top: Math.min(y0, y1), bottom: Math.max(y0, y1), dir: y1 > y0 ? 1 : -1 },
      ];
    }),
  );
  const addSpan = (row: number, from: number, to: number) => {
    const start = Math.max(0, from);
    const end = Math.min(size, to);
    for (let px = Math.floor(start); px < end; px += 1) {
      const overlap = Math.min(end, px + 1) - Math.max(start, px);
      if (overlap > 0) cover[row * size + px]! += overlap / SUBSCANLINES;
    }
  };

  for (let sub = 0; sub < size * SUBSCANLINES; sub += 1) {
    const y = (sub + 0.5) / SUBSCANLINES;
    const crossings = edges
      .filter((edge) => y >= edge.top && y < edge.bottom)
      .map((edge) => ({
        x: edge.x0 + ((y - edge.y0) * (edge.x1 - edge.x0)) / (edge.y1 - edge.y0),
        dir: edge.dir,
      }))
      .toSorted((a, b) => a.x - b.x);
    let winding = 0;
    let spanStart = 0;
    for (const crossing of crossings) {
      const before = winding;
      winding += crossing.dir;
      if (before === 0 && winding !== 0) spanStart = crossing.x;
      if (before !== 0 && winding === 0) addSpan(Math.floor(y), spanStart, crossing.x);
    }
  }
  return cover;
}

const parseHex = (hex: string) =>
  [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

/**
 * Draws the icon at `size` pixels. The plate spans `inset` to `1 - inset` of the
 * canvas on each axis.
 */
function renderIcon(size: number, inset = 0): PNG {
  const scale = (size * (1 - 2 * inset)) / FORK_APP_ICON_SIZE;
  const offset = size * inset;
  const red = new Float64Array(size * size);
  const green = new Float64Array(size * size);
  const blue = new Float64Array(size * size);
  const alpha = new Float64Array(size * size);

  for (const layer of iconLayers(size >= BADGE_LETTERS_MIN_SIZE)) {
    const polygons = layer.polygons.map((polygon) =>
      polygon.map(([x, y]) => [offset + x * scale, offset + y * scale] as const),
    );
    const cover = coverage(polygons, size);
    const [r, g, b] = parseHex(layer.color);
    for (let i = 0; i < cover.length; i += 1) {
      const a = Math.min(1, cover[i]!);
      if (a === 0) continue;
      // Source-over with straight alpha.
      const outAlpha = a + alpha[i]! * (1 - a);
      const keep = (alpha[i]! * (1 - a)) / outAlpha;
      red[i] = r! * (a / outAlpha) + red[i]! * keep;
      green[i] = g! * (a / outAlpha) + green[i]! * keep;
      blue[i] = b! * (a / outAlpha) + blue[i]! * keep;
      alpha[i] = outAlpha;
    }
  }

  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i += 1) {
    png.data[i * 4] = Math.round(red[i]!);
    png.data[i * 4 + 1] = Math.round(green[i]!);
    png.data[i * 4 + 2] = Math.round(blue[i]!);
    png.data[i * 4 + 3] = Math.round(alpha[i]! * 255);
  }
  return png;
}

export interface ForkIconArtifact {
  readonly relativePath: string;
  readonly contents: Buffer;
}

/** Everything the fork commits, derived purely from the shared icon geometry. */
export function buildForkIconArtifacts(): ReadonlyArray<ForkIconArtifact> {
  const renditions = new Map(
    [...new Set([...WINDOWS_ICON_SIZES, ...WEB_ICON_SIZES, FORK_APP_ICON_SIZE])].map((size) => [
      size,
      PNG.sync.write(renderIcon(size)),
    ]),
  );
  const windowsIco = encodePngIco(
    WINDOWS_ICON_SIZES.map((size) => ({ size, contents: renditions.get(size)! })),
  );

  // Windows, Linux and the web read the edge-to-edge plate. macOS wants Apple's
  // grid padding, so its master is inset and the packager derives its sizes.
  return [
    {
      relativePath: "assets/fork/fork-universal-1024.png",
      contents: renditions.get(FORK_APP_ICON_SIZE)!,
    },
    {
      relativePath: "assets/fork/fork-macos-1024.png",
      contents: PNG.sync.write(renderIcon(FORK_APP_ICON_SIZE, MACOS_PLATE_INSET)),
    },
    { relativePath: "assets/fork/fork-windows.ico", contents: windowsIco },
    { relativePath: "assets/fork/fork-web-favicon.ico", contents: windowsIco },
    { relativePath: "assets/fork/fork-web-favicon-16x16.png", contents: renditions.get(16)! },
    { relativePath: "assets/fork/fork-web-favicon-32x32.png", contents: renditions.get(32)! },
    { relativePath: "assets/fork/fork-web-apple-touch-180.png", contents: renditions.get(180)! },
  ];
}

export const generateForkIcons = Effect.fn("generateForkIcons")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

  for (const artifact of buildForkIconArtifacts()) {
    const target = path.join(repoRoot, artifact.relativePath);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, artifact.contents);
    yield* Console.log(`wrote ${artifact.relativePath} (${artifact.contents.length} bytes)`);
  }
});

export const generateForkIconsCommand = Command.make("generate-fork-icons", {}, () =>
  generateForkIcons(),
).pipe(Command.withDescription("Regenerate this fork's app icons from the shared icon geometry."));

if (import.meta.main) {
  Command.run(generateForkIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
