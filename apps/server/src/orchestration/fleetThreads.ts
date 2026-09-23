import type { FleetRole } from "@t3tools/contracts";

/** The First Mate thread, or a command that would create one. */
export function isFirstMateThread(thread: {
  readonly fleetRole?: FleetRole | null | undefined;
}): boolean {
  return thread.fleetRole === "first-mate";
}

/**
 * The repository a new fleet thread records. The First Mate thread works for
 * no one repository, whatever it was sent, and a blank name means none.
 */
export function resolveFleetRepo(command: {
  readonly fleetRole?: FleetRole | null | undefined;
  readonly fleetRepo?: string | null | undefined;
}): string | null {
  if (command.fleetRole == null || isFirstMateThread(command)) return null;
  const repo = command.fleetRepo?.trim() ?? "";
  return repo.length > 0 ? repo : null;
}
