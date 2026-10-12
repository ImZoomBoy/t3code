import { useAuth } from "@clerk/react";
import { type EnvironmentConflictReason, EnvironmentHttpConflictError } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { revokeRelayLinkAfterLocalUnlink } from "./forkRevokeRelayLink";
import type { CloudLinkTarget } from "./linkEnvironment";
import { unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom } from "./linkEnvironmentAtoms";
import type { usePrimaryCloudLinkState } from "./primaryCloudLinkState";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
import type { CloudLinkDesiredState } from "./useCloudLinkController";

export const UNLINK_THIS_PC_LABEL = "Unlink this PC";

const isEnvironmentConflict = Schema.is(EnvironmentHttpConflictError);

// What the environment server reports when a relay config names another
// account than the stored link (validateLinkedCloudUser in apps/server/src/cloud).
const LINKED_TO_DIFFERENT_ACCOUNT: EnvironmentConflictReason = "linked_to_different_cloud_account";

// Matched on the typed reason, never on the message. A reason this client does
// not know, or none at all from an older server, is not a match.
function isLinkedAccountConflict(cause: unknown): boolean {
  if (isEnvironmentConflict(cause)) {
    return cause.reason === LINKED_TO_DIFFERENT_ACCOUNT;
  }
  return typeof cause === "object" && cause !== null && "cause" in cause
    ? isLinkedAccountConflict(cause.cause)
    : false;
}

/**
 * Words T3 Connect failures for the controller and remembers whether the last
 * one was the different-account conflict. That conflict is reworded to name
 * the control that clears it. Every other failure keeps its own message.
 */
export function useForkLinkFailures() {
  const accountConflictSeen = useRef(false);
  const describeFailure = (cause: unknown, message: string) => {
    accountConflictSeen.current = isLinkedAccountConflict(cause);
    return accountConflictSeen.current
      ? `This PC is already linked to a different T3 Connect account. Use "${UNLINK_THIS_PC_LABEL}" in Settings > Connections, then try again.`
      : message;
  };
  return {
    describeFailure,
    forgetLast: () => {
      accountConflictSeen.current = false;
    },
    lastWasAccountConflict: () => accountConflictSeen.current,
  };
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

const UNLINKED_TITLE = "This PC is unlinked";

const UNLINKED_BY_ROW: UnlinkToast = {
  type: "success",
  title: UNLINKED_TITLE,
  description: "The T3 Connect link stored on this PC was removed.",
};

const UNLINKED_BY_SWITCHES: UnlinkToast = {
  type: "success",
  title: UNLINKED_TITLE,
  description:
    "T3 Connect and agent activity are both off, so the T3 Connect link stored on this PC was removed.",
};

const UNLINKED_UNKNOWN_LINK: UnlinkToast = {
  type: "success",
  title: "No T3 Connect link is stored on this PC",
  description: "If this PC held a link, it was removed.",
};

// The relay keys a link by account and environment, so a revoke only removes
// the signed-in account's own entry. Each warning below covers one way the
// entry of the account that made the link can outlive the local unlink.
const OTHER_ACCOUNT_STILL_LISTS_THIS_PC: UnlinkToast = {
  type: "warning",
  title: "Another account still lists this PC",
  description:
    "The T3 Connect account that linked this PC still lists it. To remove it there, sign in as that account and choose Deregister.",
};

const SIGNED_OUT_ACCOUNT_STILL_LISTS_THIS_PC: UnlinkToast = {
  type: "warning",
  title: "T3 Connect still lists this PC",
  description:
    "You are signed out of T3 Connect, so the account that linked this PC still lists it. To remove it there, sign in as that account and choose Deregister.",
};

const OWN_ACCOUNT_MAY_STILL_LIST_THIS_PC: UnlinkToast = {
  type: "warning",
  title: "T3 Connect may still list this PC",
  description:
    "This PC could not be removed from your T3 Connect account. If your account still lists it, choose Deregister there.",
};

type UnlinkSource = "row" | "switches" | "refused-switch-off";

/**
 * The fork's unlink for the primary environment: the "Unlink this PC" row and
 * the Settings switches. The local unlink always runs first and needs no relay
 * token. The relay revoke follows on its own and never holds the unlink up.
 */
export function useForkUnlinkThisPc(input: {
  readonly linkState: ReturnType<typeof usePrimaryCloudLinkState>;
  readonly managedTunnelActive: boolean;
  readonly linkFailures: ReturnType<typeof useForkLinkFailures>;
  readonly reconcileCloudState: (desired: CloudLinkDesiredState) => Promise<boolean>;
  readonly clearFailure: () => void;
  readonly reportFailure: (cause: unknown) => void;
}) {
  const { getToken, isSignedIn, userId } = useAuth();
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const revokeRelayLink = useAtomCommand(revokeRelayLinkAfterLocalUnlink, {
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

  const revokeAtRelay = async (target: CloudLinkTarget, warnWhenNotRevoked: boolean) => {
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    const clerkToken = tokenResult._tag === "Success" ? tokenResult.value : null;
    const revoked = clerkToken
      ? (await revokeRelayLink({ target, clerkToken }))._tag === "Success"
      : false;
    if (!revoked && warnWhenNotRevoked) {
      toastManager.add(OWN_ACCOUNT_MAY_STILL_LIST_THIS_PC);
    }
    await refreshRelayEnvironments();
  };

  const unlink = async (source: UnlinkSource): Promise<boolean> => {
    input.clearFailure();
    const target = input.linkState.target;
    if (!target) {
      input.reportFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    const unlinkResult = await unlinkPrimaryEnvironment({ target, clerkToken: null });
    input.linkState.refresh();
    if (unlinkResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(unlinkResult)) {
        input.reportFailure(squashAtomCommandFailure(unlinkResult));
      }
      return false;
    }
    const knownLink = unlinkOffer === "linked";
    const toasts = [
      // The switch that asked for "both off" adds its own success toast.
      ...(source === "switches"
        ? []
        : source === "refused-switch-off"
          ? [UNLINKED_BY_SWITCHES]
          : knownLink
            ? [UNLINKED_BY_ROW]
            : [UNLINKED_UNKNOWN_LINK]),
      ...(!knownLink
        ? []
        : linkedAccountDiffers
          ? [OTHER_ACCOUNT_STILL_LISTS_THIS_PC]
          : isSignedIn
            ? []
            : [SIGNED_OUT_ACCOUNT_STILL_LISTS_THIS_PC]),
    ];
    // A switch adds its own toast as soon as this resolves. Adding ours one
    // task later keeps them on top of it, where the warning can be read.
    setTimeout(() => {
      for (const toast of toasts) {
        toastManager.add(toast);
      }
    }, 0);
    // With another account signed in, the revoke clears the publish-only entry
    // that account's refused link attempts left at the relay.
    if (isSignedIn) {
      void revokeAtRelay(target, knownLink && !linkedAccountDiffers);
    }
    return true;
  };

  // The state a T3 Connect switch-off was refused in. A carried switch-off only
  // counts while the account, the environment and the link are all unchanged.
  const refusedTunnelOffIn = useRef<string | null>(null);
  const switchState = JSON.stringify([
    userId ?? null,
    input.linkState.target?.environmentId ?? null,
    input.linkState.data,
  ]);

  /**
   * `reconcileCloudState` for the two Settings switches. Never use it from
   * onboarding, which must not tear down a link.
   *
   * Switching T3 Connect off while publishing stays on needs a relink, which
   * this PC refuses when another account is signed in. The switch then still
   * shows ON, so switching publishing off next would only write the preference
   * and keep the link. Here that next request unlinks instead, as long as it
   * directly follows the refusal and nothing changed in between.
   */
  const reconcileSettingsSwitches = async (requested: CloudLinkDesiredState): Promise<boolean> => {
    const carriesRefusedTunnelOff =
      refusedTunnelOffIn.current === switchState &&
      input.managedTunnelActive &&
      requested.managedTunnel &&
      !requested.publish;
    refusedTunnelOffIn.current = null;
    if (carriesRefusedTunnelOff) {
      return unlink("refused-switch-off");
    }
    if (!requested.managedTunnel && !requested.publish) {
      return unlink("switches");
    }
    input.linkFailures.forgetLast();
    const ok = await input.reconcileCloudState(requested);
    if (
      !ok &&
      input.managedTunnelActive &&
      !requested.managedTunnel &&
      input.linkFailures.lastWasAccountConflict()
    ) {
      refusedTunnelOffIn.current = switchState;
    }
    return ok;
  };

  return {
    linkedAccountDiffers,
    reconcileSettingsSwitches,
    unlinkOffer,
    unlinkThisPc: () => unlink("row"),
  };
}
