import { useAuth } from "@clerk/react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom } from "./linkEnvironmentAtoms";
import type { usePrimaryCloudLinkState } from "./primaryCloudLinkState";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export const UNLINK_THIS_PC_LABEL = "Unlink this PC";

// The environment server's wording when a relay config names another account
// than the stored link (validateLinkedCloudUser in apps/server/src/cloud).
const LINKED_ACCOUNT_CONFLICT = "linked to a different cloud account";

/**
 * Rewrites the server's different-account conflict so it names the control
 * that clears it. Every other failure message passes through unchanged.
 */
export function describeCloudLinkFailure(message: string): string {
  return message.includes(LINKED_ACCOUNT_CONFLICT)
    ? `This PC is already linked to a different T3 Connect account. Use "${UNLINK_THIS_PC_LABEL}" in Settings > Connections, then try again.`
    : message;
}

/**
 * True only when both account ids are known and differ. An unknown id on
 * either side is not a mismatch.
 */
function isLinkedToDifferentAccount(input: {
  readonly linkedCloudUserId: string | null | undefined;
  readonly signedInUserId: string | null | undefined;
}): boolean {
  return Boolean(
    input.linkedCloudUserId &&
    input.signedInUserId &&
    input.linkedCloudUserId !== input.signedInUserId,
  );
}

/**
 * The fork's explicit unlink for the primary environment. Unlike
 * `reconcileCloudState`, it does not depend on what the switches show, so it
 * is reachable from every linked state, and it never needs a relay token: the
 * local unlink always runs, and the relay revoke is attempted only when the
 * signed-in account is not known to differ from the one that made the link.
 */
export function useForkUnlinkThisPc(input: {
  readonly linkState: ReturnType<typeof usePrimaryCloudLinkState>;
  readonly clearFailure: () => void;
  readonly reportFailure: (cause: unknown) => void;
}) {
  const { getToken, isSignedIn, userId } = useAuth();
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkedAccountDiffers = isLinkedToDifferentAccount({
    linkedCloudUserId: input.linkState.data?.cloudUserId,
    signedInUserId: userId,
  });

  const unlinkThisPc = async (): Promise<boolean> => {
    input.clearFailure();
    const target = input.linkState.target;
    if (!target) {
      input.reportFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    const canRevokeAtRelay = Boolean(isSignedIn) && !linkedAccountDiffers;
    const tokenResult = canRevokeAtRelay
      ? await settlePromise(() => getToken(resolveRelayClerkTokenOptions()))
      : null;
    const unlinkResult = await unlinkPrimaryEnvironment({
      target,
      clerkToken: tokenResult?._tag === "Success" ? (tokenResult.value ?? null) : null,
    });
    input.linkState.refresh();
    if (unlinkResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(unlinkResult)) {
        input.reportFailure(squashAtomCommandFailure(unlinkResult));
      }
      return false;
    }
    // The local link is gone at this point. The relay list only exists for a
    // signed-in account, and a failed refresh of it does not undo the unlink.
    if (isSignedIn) {
      await refreshRelayEnvironments();
    }
    return true;
  };

  return { linkedAccountDiffers, unlinkThisPc };
}
