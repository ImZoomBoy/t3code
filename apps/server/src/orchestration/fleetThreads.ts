import type { FleetRole, OrchestrationCommand, OrchestrationThread } from "@t3tools/contracts";

/** The First Mate thread, or a command that would create one. */
export function isFirstMateThread(thread: {
  readonly fleetRole?: FleetRole | null | undefined;
}): boolean {
  return thread.fleetRole === "first-mate";
}

/**
 * Why the fleet may not make this thread promptable, or null when it may.
 *
 * Only a second mate's thread is handed to the user. A worker's thread stays
 * the worker's, the First Mate thread is never read-only to begin with, and a
 * thread the fleet did not create is not the fleet's to clear.
 */
export function readOnlyClearRefusal(
  thread: Pick<OrchestrationThread, "id" | "fleetOwned" | "fleetRole">,
  issuer: Extract<OrchestrationCommand, { type: "thread.read-only.clear" }>["issuer"],
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
 * The repository the fleet may record on this thread with
 * `thread.fleet-berth.set`, or why it may not.
 *
 * The command repairs a thread the fleet created before it sent `fleetRole`.
 * It never makes or unmakes the First Mate thread: only `thread.create` does
 * that, so the one-live-First-Mate rule holds in one place. A thread the fleet
 * did not create is not the fleet's to label.
 */
export function resolveFleetBerth(
  thread: Pick<OrchestrationThread, "id" | "fleetOwned" | "fleetRole">,
  command: Pick<
    Extract<OrchestrationCommand, { type: "thread.fleet-berth.set" }>,
    "issuer" | "fleetRole" | "fleetRepo"
  >,
): { readonly fleetRepo: string } | { readonly refusal: string } {
  if (command.issuer !== "fleet") {
    return { refusal: `Only the fleet may set the berth of thread '${thread.id}'.` };
  }
  if (isFirstMateThread(command)) {
    return {
      refusal: `The First Mate thread is only made by thread.create, so thread '${thread.id}' cannot become one.`,
    };
  }
  if (thread.fleetOwned !== true) {
    return { refusal: `Thread '${thread.id}' is not fleet-owned, so its berth stays as it is.` };
  }
  if (isFirstMateThread(thread)) {
    return {
      refusal: `Thread '${thread.id}' is the First Mate thread, so its berth stays as it is.`,
    };
  }
  const fleetRepo = resolveFleetRepo(command);
  if (fleetRepo === null) {
    return { refusal: `Setting the berth of thread '${thread.id}' needs a repository.` };
  }
  return { fleetRepo };
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
