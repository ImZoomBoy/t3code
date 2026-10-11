import { useAuth } from "@clerk/react";
import { EnvironmentHttpConflictError } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom } from "./linkEnvironmentAtoms";
import type { usePrimaryCloudLinkState } from "./primaryCloudLinkState";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export const UNLINK_THIS_PC_LABEL = "Unlink this PC";

const isEnvironmentConflict = Schema.is(EnvironmentHttpConflictError);

// The conflict the environment server reports when a relay config names
// another account than the stored link (validateLinkedCloudUser in
// apps/server/src/cloud). Matched on its typed reason, never on its message.
function isLinkedAccountConflict(cause: unknown): boolean {
  if (isEnvironmentConflict(cause)) {
    return cause.reason === "linked_to_different_cloud_account";
  }
  return typeof cause === "object" && cause !== null && "cause" in cause
    ? isLinkedAccountConflict(cause.cause)
    : false;
}

/**
 * Rewrites the server's different-account conflict so it names the control
 * that clears it. Every other failure keeps its own message, and so does the
 * conflict from a server too old to send the reason.
 */
export function describeCloudLinkFailure(cause: unknown, message: string): string {
  return isLinkedAccountConflict(cause)
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
 * Whether to offer the unlink: "linked" when a link is stored, "unknown" when
 * the link state could not be read, "none" when there is no link to remove.
 */
export type UnlinkThisPcOffer = "linked" | "unknown" | "none";

type UnlinkToast = Parameters<typeof toastManager.add>[0];

// The relay keys a link by account and environment, so a revoke only removes
// the signed-in account's own entry. The account that made the link keeps
// listing this PC, and only that account can remove it.
const LINKING_ACCOUNT_STILL_LISTS_THIS_PC: UnlinkToast = {
  type: "warning",
  title: "Another account still lists this PC",
  description:
    "The T3 Connect account that linked this PC still lists it. To remove it there, sign in as that account and choose Deregister.",
};

const UNLINKED_BY_SWITCHES: UnlinkToast = {
  type: "success",
  title: "This PC is unlinked",
  description:
    "T3 Connect and agent activity are both off, so the T3 Connect link stored on this PC was removed.",
};

interface WantedCloudFeatures {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
}

/**
 * The fork's explicit unlink for the primary environment. Unlike
 * `reconcileCloudState`, it does not depend on what the switches show, so it
 * is reachable from every linked state and when the link state is unreadable.
 * It never needs a relay token: the local unlink always runs first, and the
 * relay revoke that follows is best effort.
 */
export function useForkUnlinkThisPc(input: {
  readonly linkState: ReturnType<typeof usePrimaryCloudLinkState>;
  readonly managedTunnelActive: boolean;
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
  const unlinkOffer: UnlinkThisPcOffer = input.linkState.data?.linked
    ? "linked"
    : input.linkState.error !== null
      ? "unknown"
      : "none";
  const tunnelOffRefused = useRef(false);

  // Toasts for an unlink that a switch caused. They are added after the render
  // that follows it, so they land on top of the toast the switch itself adds.
  const [switchUnlinkToasts, setSwitchUnlinkToasts] = useState<ReadonlyArray<UnlinkToast>>([]);
  useEffect(() => {
    for (const toast of switchUnlinkToasts) {
      toastManager.add(toast);
    }
  }, [switchUnlinkToasts]);

  const unlinkThisPc = async (): Promise<boolean> => {
    input.clearFailure();
    const target = input.linkState.target;
    if (!target) {
      input.reportFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    // With another account signed in, the revoke clears the publish-only entry
    // that account's refused link attempts left at the relay.
    const tokenResult = isSignedIn
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
    tunnelOffRefused.current = false;
    toastManager.add(
      unlinkOffer === "linked"
        ? {
            type: "success",
            title: "This PC is unlinked",
            description: "The T3 Connect link stored on this PC was removed.",
          }
        : {
            type: "success",
            title: "No T3 Connect link is stored on this PC",
            description: "If this PC held a link, it was removed.",
          },
    );
    if (linkedAccountDiffers || (unlinkOffer === "linked" && !isSignedIn)) {
      toastManager.add(LINKING_ACCOUNT_STILL_LISTS_THIS_PC);
    }
    // The local link is gone at this point. The relay list only exists for a
    // signed-in account, and a failed refresh of it does not undo the unlink.
    if (isSignedIn) {
      await refreshRelayEnvironments();
    }
    return true;
  };

  /**
   * Wraps `reconcileCloudState` so a refused switch-off still counts as what
   * the user wants. Switching T3 Connect off while publishing stays on needs a
   * relink, which the relay or this PC can refuse (another account is signed
   * in, the relay is down). The tunnel then still shows ON, and switching
   * publishing off next would only write the preference and keep the link.
   * Carrying the refused switch-off into that next request makes it the unlink
   * the user asked for. Only the request right after the refusal carries it.
   */
  const carryRefusedTunnelOff =
    (reconcile: (desired: WantedCloudFeatures) => Promise<boolean>) =>
    async (requested: WantedCloudFeatures): Promise<boolean> => {
      const carried =
        tunnelOffRefused.current &&
        input.managedTunnelActive &&
        requested.managedTunnel &&
        !requested.publish;
      tunnelOffRefused.current = false;
      const desired = carried ? { managedTunnel: false, publish: false } : requested;
      const ok = await reconcile(desired);
      if (!ok) {
        tunnelOffRefused.current = input.managedTunnelActive && !desired.managedTunnel;
        return false;
      }
      if (!desired.managedTunnel && !desired.publish) {
        setSwitchUnlinkToasts([
          ...(carried ? [UNLINKED_BY_SWITCHES] : []),
          ...(linkedAccountDiffers ? [LINKING_ACCOUNT_STILL_LISTS_THIS_PC] : []),
        ]);
      }
      return true;
    };

  return { carryRefusedTunnelOff, linkedAccountDiffers, unlinkOffer, unlinkThisPc };
}
