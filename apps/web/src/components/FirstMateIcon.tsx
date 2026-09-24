import { ShipWheelIcon, type LucideProps } from "lucide-react";

import { cn } from "~/lib/utils";

/** First Mate's mark: a pink ship's wheel, shown wherever other rows show a project. */
export function FirstMateIcon({ className, ...props }: LucideProps) {
  return (
    <ShipWheelIcon
      aria-hidden
      {...props}
      className={cn("size-4 shrink-0 text-pink-500 dark:text-pink-400", className)}
    />
  );
}
