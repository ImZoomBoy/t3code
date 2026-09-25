import type { FleetRole } from "@t3tools/contracts";
import { PickaxeIcon, SailboatIcon, ShipIcon, type LucideProps } from "lucide-react";

import { cn } from "~/lib/utils";

const FLEET_ROLE_ICONS = {
  "first-mate": ShipIcon,
  "second-mate": SailboatIcon,
  worker: PickaxeIcon,
} as const;

/**
 * A fleet thread's role mark, drawn beside its project icon: a ship for First
 * Mate, a sailboat for a second mate, a pickaxe for a worker. The caller gives
 * it the thread's text colour.
 */
export function FleetRoleIcon({ role, className, ...props }: LucideProps & { role: FleetRole }) {
  const Icon = FLEET_ROLE_ICONS[role];
  return <Icon aria-hidden {...props} className={cn("size-3.5 shrink-0", className)} />;
}
