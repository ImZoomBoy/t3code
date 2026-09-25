import { MONITOR_TASK_TYPES } from "@t3tools/contracts";

/**
 * A background shell or monitor task that stopped before it finished. A
 * resumed Claude session reports every one its previous process left
 * running, so several arrive together; both clients fold them into one row.
 */
export interface StoppedBackgroundCommand {
  readonly taskId: string;
  readonly description: string | undefined;
}

/** Reads a stopped background command from a task.completed activity. */
export function readStoppedBackgroundCommand(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): StoppedBackgroundCommand | undefined {
  if (activity.kind !== "task.completed") return undefined;
  const payload =
    activity.payload !== null && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (
    payload === null ||
    payload.status !== "stopped" ||
    payload.agentKind === "agent" ||
    typeof payload.taskId !== "string" ||
    typeof payload.taskType !== "string" ||
    !MONITOR_TASK_TYPES.has(payload.taskType)
  ) {
    return undefined;
  }
  const description = typeof payload.title === "string" ? payload.title.trim() : "";
  return { taskId: payload.taskId, description: description || undefined };
}

/** Adds commands to a row's set, once per task. */
export function mergeStoppedBackgroundCommands(
  current: ReadonlyArray<StoppedBackgroundCommand>,
  next: ReadonlyArray<StoppedBackgroundCommand>,
): ReadonlyArray<StoppedBackgroundCommand> {
  const taskIds = new Set(current.map((command) => command.taskId));
  return [...current, ...next.filter((command) => !taskIds.has(command.taskId))];
}

/** The row label, e.g. "3 background commands stopped: Watch CI; Tail logs". */
export function stoppedBackgroundCommandsLabel(
  commands: ReadonlyArray<StoppedBackgroundCommand>,
): string {
  const heading =
    commands.length === 1
      ? "Background command stopped"
      : `${commands.length} background commands stopped`;
  const descriptions = [
    ...new Set(commands.flatMap((command) => (command.description ? [command.description] : []))),
  ];
  return descriptions.length > 0 ? `${heading}: ${descriptions.join("; ")}` : heading;
}
