/**
 * DeciderContext - what the decider may ask the engine beyond the read model.
 *
 * The engine provides it around each decision. Code that decides without an
 * engine, such as a test, gets the default, which holds no environment.
 *
 * @module DeciderContext
 */
import type { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export interface DeciderContextShape {
  /**
   * Whether the engine still holds the environment of the deferred turn start
   * sent under this command id. False for every one after a restart.
   */
  readonly hasDeferredTurnEnvironment: (commandId: CommandId) => boolean;
}

export const DeciderContext = Context.Reference<DeciderContextShape>(
  "t3/orchestration/DeciderContext",
  { defaultValue: () => ({ hasDeferredTurnEnvironment: () => false }) },
);
