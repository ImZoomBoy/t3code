import { ShipIcon, type LucideProps } from "lucide-react";

import { cn } from "~/lib/utils";
import { FIRST_MATE_TONE_CLASS } from "./sidebar/fleetSidebar.logic";

/** First Mate's mark: a ship in First Mate's colour. */
export function FirstMateIcon({ className, ...props }: LucideProps) {
  return (
    <ShipIcon
      aria-hidden
      {...props}
      className={cn("size-4 shrink-0", FIRST_MATE_TONE_CLASS, className)}
    />
  );
}
