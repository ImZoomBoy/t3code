import type { FleetRole } from "@t3tools/contracts";
import { AnchorIcon, ShipWheelIcon, WrenchIcon, type LucideProps } from "lucide-react";

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

/**
 * A fleet thread's role mark: First Mate's pink wheel, a second mate's blue
 * anchor, a worker's grey wrench. Shape and colour both differ, so the three
 * read apart at a glance.
 */
export function FleetRoleIcon({ role, className, ...props }: LucideProps & { role: FleetRole }) {
  switch (role) {
    case "first-mate":
      return <FirstMateIcon className={className} {...props} />;
    case "second-mate":
      return (
        <AnchorIcon
          aria-hidden
          {...props}
          className={cn("size-4 shrink-0 text-sky-600 dark:text-sky-400", className)}
        />
      );
    case "worker":
      return (
        <WrenchIcon
          aria-hidden
          {...props}
          className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
        />
      );
  }
}
