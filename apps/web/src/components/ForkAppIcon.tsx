import {
  FORK_APP_ICON_BADGE,
  FORK_APP_ICON_COLORS,
  FORK_APP_ICON_PLATE_RADIUS,
  FORK_APP_ICON_SIZE,
  FORK_APP_ICON_WORDMARK,
  FORK_BADGE_LETTER_STROKE_WIDTH,
  forkBadgeLetterStrokes,
} from "@t3tools/shared/forkAppIcon";
import type { SVGProps } from "react";

import { APP_FORK_BADGE_LABEL } from "../branding";

const badgeLetterStrokes = forkBadgeLetterStrokes(APP_FORK_BADGE_LABEL).map((stroke) =>
  stroke.map((point) => point.join(",")).join(" "),
);

/**
 * The fork's app icon, drawn from the same geometry `scripts/generate-fork-icons.ts`
 * rasterises into the desktop and taskbar icons, so the two always match.
 */
export function ForkAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      viewBox={`0 0 ${FORK_APP_ICON_SIZE} ${FORK_APP_ICON_SIZE}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        fill={FORK_APP_ICON_COLORS.plate}
        height={FORK_APP_ICON_SIZE}
        rx={FORK_APP_ICON_PLATE_RADIUS}
        width={FORK_APP_ICON_SIZE}
      />
      <path
        d={FORK_APP_ICON_WORDMARK.path}
        fill={FORK_APP_ICON_COLORS.artwork}
        transform={`translate(${FORK_APP_ICON_WORDMARK.x} ${FORK_APP_ICON_WORDMARK.y}) scale(${FORK_APP_ICON_WORDMARK.scale})`}
      />
      <circle
        cx={FORK_APP_ICON_BADGE.cx}
        cy={FORK_APP_ICON_BADGE.cy}
        fill={FORK_APP_ICON_COLORS.artwork}
        r={FORK_APP_ICON_BADGE.ringRadius}
      />
      <circle
        cx={FORK_APP_ICON_BADGE.cx}
        cy={FORK_APP_ICON_BADGE.cy}
        fill={FORK_APP_ICON_COLORS.badge}
        r={FORK_APP_ICON_BADGE.fillRadius}
      />
      <g
        fill="none"
        stroke={FORK_APP_ICON_COLORS.artwork}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={FORK_BADGE_LETTER_STROKE_WIDTH}
      >
        {badgeLetterStrokes.map((points) => (
          <polyline key={points} points={points} />
        ))}
      </g>
    </svg>
  );
}
