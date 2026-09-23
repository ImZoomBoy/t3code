import type { SVGProps } from "react";

import { T3Wordmark } from "./T3Wordmark";

/**
 * The fork's app icon, drawn to match `assets/fork/fork-universal-1024.png` in that file's
 * 1024-unit space, so it stays crisp at any size. The "AP" badge marks the fork.
 */
export function ForkAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
      <rect fill="#C2410C" height="1024" rx="260" width="1024" />
      <T3Wordmark color="#FFFFFF" height="471" width="780" x="100" y="285" />
      <circle cx="732" cy="732" fill="#FFFFFF" r="204" />
      <circle cx="732" cy="732" fill="#0B1220" r="178" />
      <text
        fill="#FFFFFF"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="166"
        fontWeight="800"
        textAnchor="middle"
        x="732"
        y="791"
      >
        AP
      </text>
    </svg>
  );
}
