import { EnvironmentId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { type CloudLinkTarget, readPrimaryCloudLinkState } from "./linkEnvironment";
import { resolveCloudPublicConfig } from "./publicConfig";

/**
 * Removes the token's own relay entry for an environment that was just
 * unlinked locally. Run it after the local unlink, never before: the token may
 * arrive late, so it first checks that the environment has not been linked
 * again in the meantime and leaves the relay alone when it has.
 */
export const revokeRelayLinkAfterLocalUnlink = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:revoke-relay-link-after-local-unlink",
  execute: (input: { readonly target: CloudLinkTarget; readonly clerkToken: string }) =>
    Effect.gen(function* () {
      if (!resolveCloudPublicConfig().relayUrl) return;
      const linkState = yield* readPrimaryCloudLinkState({ target: input.target });
      if (linkState?.linked) return;
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient.unlinkEnvironment({
        clerkToken: input.clerkToken,
        environmentId: EnvironmentId.make(input.target.environmentId),
      });
    }),
});
