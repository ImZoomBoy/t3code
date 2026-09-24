import type { FleetRole, OrchestrationThread } from "@t3tools/contracts";

/** The First Mate thread, or a command that would create one. */
export function isFirstMateThread(thread: {
  readonly fleetRole?: FleetRole | null | undefined;
}): boolean {
  return thread.fleetRole === "first-mate";
}

/**
 * Why the fleet may not make this thread promptable, or null when it may.
 *
 * Only a second mate's thread is handed to the person. A worker's thread stays
 * the worker's, the First Mate thread is never read-only to begin with, and a
 * thread the fleet did not create is not the fleet's to open.
 */
export function readOnlyClearRefusal(
  thread: Pick<OrchestrationThread, "id" | "fleetOwned" | "fleetRole">,
  issuer: "fleet" | undefined,
): string | null {
  if (issuer !== "fleet") {
    return `Only the fleet may make thread '${thread.id}' promptable.`;
  }
  if (thread.fleetOwned !== true || thread.fleetRole !== "second-mate") {
    return `Thread '${thread.id}' is not a fleet-owned second mate thread, so it stays as it is.`;
  }
  return null;
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
