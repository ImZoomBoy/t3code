/**
 * TurnEnvironment - side channel for a turn start's `environment`.
 *
 * The field is absent from every orchestration event on purpose: its values
 * name paths on the server's filesystem, which no client needs and none may
 * display, so it must not reach persisted state, the timeline, or the wire.
 * The engine parks it here once the command commits, and the provider reactor
 * takes it when it handles that command's `thread.turn-start-requested`.
 * Taking removes it, so a later turn on the same thread never inherits it.
 *
 * A deferred turn start's environment waits with the engine instead, until
 * the start runs or is dropped. See `makeDeferredTurnEnvironments`.
 *
 * @module TurnEnvironment
 */
import type {
  CommandId,
  OrchestrationCommand,
  OrchestrationEvent,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

// A parked entry is normally taken within one event round trip. The cap is
// there for the turn start that is deduplicated or dropped, so a missed take
// costs one entry rather than growing the map for the life of the process.
const MAX_PARKED_TURN_ENVIRONMENTS = 256;

const environmentsByCommandId = new Map<CommandId, ProviderInstanceEnvironment>();

const rememberTurnEnvironment = Effect.fnUntraced(function* (command: OrchestrationCommand) {
  if (command.type !== "thread.turn.start" || command.environment === undefined) {
    return;
  }
  yield* parkTurnEnvironment(command.commandId, command.environment);
});

const parkTurnEnvironment = Effect.fnUntraced(function* (
  commandId: CommandId,
  environment: ProviderInstanceEnvironment,
) {
  if (environmentsByCommandId.size >= MAX_PARKED_TURN_ENVIRONMENTS) {
    const oldest = environmentsByCommandId.keys().next();
    if (!oldest.done) {
      environmentsByCommandId.delete(oldest.value);
      // An eviction means a turn start parked an environment that nobody took.
      // The turn it belonged to spawns without its tooling, so say which one.
      yield* Effect.logWarning("Evicted a parked turn environment that was never taken.", {
        commandId: oldest.value,
        parked: MAX_PARKED_TURN_ENVIRONMENTS,
      });
    }
  }
  environmentsByCommandId.set(commandId, environment);
});

/**
 * The environments of deferred turn starts, owned by one engine. They live
 * exactly as long as that engine, so after a restart `has` is false and the
 * decider drops the start with `environment-lost`.
 *
 * No cap: every entry is removed by the event that runs or drops its start.
 */
export function makeDeferredTurnEnvironments() {
  const deferred = new Map<CommandId, ProviderInstanceEnvironment>();
  return {
    has: (commandId: CommandId): boolean => deferred.has(commandId),
    /**
     * Call once per committed command, with the events it wrote, before they
     * are published, so the provider reactor finds every environment it needs.
     */
    remember: Effect.fnUntraced(function* (
      command: OrchestrationCommand,
      committedEvents: ReadonlyArray<OrchestrationEvent>,
    ) {
      for (const event of committedEvents) {
        if (event.commandId === null) continue;
        if (event.type === "thread.turn-start-requested") {
          const environment = deferred.get(event.commandId);
          if (environment === undefined) continue;
          deferred.delete(event.commandId);
          yield* parkTurnEnvironment(event.commandId, environment);
        } else if (event.type === "thread.deferred-turn-start-dropped") {
          deferred.delete(event.commandId);
        }
      }
      if (
        command.type === "thread.turn.start" &&
        command.environment !== undefined &&
        committedEvents.some((event) => event.type === "thread.turn-start-deferred")
      ) {
        deferred.set(command.commandId, command.environment);
        return;
      }
      yield* rememberTurnEnvironment(command);
    }),
  };
}

export function takeTurnEnvironment(
  commandId: CommandId | null,
): ProviderInstanceEnvironment | undefined {
  if (commandId === null) {
    return undefined;
  }
  const environment = environmentsByCommandId.get(commandId);
  environmentsByCommandId.delete(commandId);
  return environment;
}

/**
 * Spread this into a call's payload to carry an environment only when the turn
 * had one. The field stays absent otherwise, which is what an `exactOptional`
 * field wants and what keeps a turn without an environment from writing an
 * `undefined` over the instance value.
 */
export function withTurnEnvironment(environment: ProviderInstanceEnvironment | undefined): {
  readonly environment?: ProviderInstanceEnvironment;
} {
  return environment === undefined ? {} : { environment };
}

/**
 * Whether two turn environments would give a process the same variables.
 *
 * The comparison is over the set of names and their values. Order does not
 * count, and neither does any other field on an entry, because only the name
 * and the value reach the process.
 *
 * Names are compared without case, the way `applyTurnEnvironment` in
 * `apps/server/src/provider/Drivers/ClaudeHome.ts` resolves them. Windows
 * treats variable names without case, so two entries whose names differ only
 * in case are one variable there and the last entry wins. This folds the same
 * way, so it cannot call two environments different that a spawn would make
 * the same.
 *
 * A missing environment and an empty one are alike. Neither adds a variable to
 * the spawn, so neither is a reason to restart a session.
 */
export function sameTurnEnvironment(
  left: ProviderInstanceEnvironment | undefined,
  right: ProviderInstanceEnvironment | undefined,
): boolean {
  const leftValues = toValuesByFoldedName(left);
  const rightValues = toValuesByFoldedName(right);
  if (leftValues.size !== rightValues.size) {
    return false;
  }
  for (const [name, value] of leftValues) {
    if (rightValues.get(name) !== value) {
      return false;
    }
  }
  return true;
}

function toValuesByFoldedName(
  environment: ProviderInstanceEnvironment | undefined,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const variable of environment ?? []) {
    values.set(variable.name.toUpperCase(), variable.value);
  }
  return values;
}
