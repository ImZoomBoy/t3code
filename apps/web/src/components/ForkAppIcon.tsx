import type { SVGProps } from "react";

import { APP_FORK_BADGE_LABEL } from "../branding";
import { T3Wordmark } from "./T3Wordmark";

/**
 * The fork's app icon, drawn after `assets/fork/fork-universal-1024.png` in that file's
 * 1024-unit space. The badge marks the fork. Unlike the PNG, the badge sits clear of the
 * letters, so the 3 stays whole at sidebar size. The badge letters use the system font.
 */
export function ForkAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
      <rect fill="#C2410C" height="1024" rx="260" width="1024" />
      <T3Wordmark color="#FFFFFF" height="374" width="620" x="120" y="170" />
      <circle cx="790" cy="790" fill="#FFFFFF" r="200" />
      <circle cx="790" cy="790" fill="#0B1220" r="174" />
      <text
        fill="#FFFFFF"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="162"
        fontWeight="800"
        textAnchor="middle"
        x="790"
        y="848"
      >
        {APP_FORK_BADGE_LABEL}
      </text>
    </svg>
  );
}
