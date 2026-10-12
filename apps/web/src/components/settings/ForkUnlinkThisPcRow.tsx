import { useState } from "react";

import { UNLINK_THIS_PC_LABEL, type UnlinkThisPcOffer } from "~/cloud/forkUnlinkThisPc";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

/**
 * Shown under the T3 Connect switches whenever this environment holds a link,
 * whatever the switches show, and when the link state could not be read. Needs
 * permission to manage T3 Connect, but not a T3 Connect sign-in.
 */
export function ForkUnlinkThisPcRow({
  offer,
  linkedAccountDiffers,
  canManageRelay,
  disabled,
  unlinkThisPc,
  onBusyChange,
}: {
  readonly offer: UnlinkThisPcOffer;
  readonly linkedAccountDiffers: boolean;
  readonly canManageRelay: boolean;
  readonly disabled: boolean;
  readonly unlinkThisPc: () => Promise<boolean>;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const [isUnlinking, setIsUnlinking] = useState(false);
  if (offer === "none") return null;

  const unlink = async () => {
    setIsUnlinking(true);
    onBusyChange(true);
    await unlinkThisPc();
    setIsUnlinking(false);
    onBusyChange(false);
  };

  const control = (
    <Button
      size="sm"
      variant="destructive-outline"
      disabled={!canManageRelay || disabled || isUnlinking}
      onClick={() => void unlink()}
    >
      {isUnlinking ? "Unlinking…" : "Unlink"}
    </Button>
  );

  return (
    <SettingsRow
      title={UNLINK_THIS_PC_LABEL}
      description={
        offer === "unknown"
          ? "T3 Code could not read whether this PC holds a T3 Connect link. If it does, this removes it."
          : linkedAccountDiffers
            ? "This PC is linked to a different T3 Connect account than the one you are signed in to. Unlink it, then switch T3 Connect on to link it to this account."
            : "Remove the T3 Connect link stored on this PC. This works without signing in to the account that made the link."
      }
      control={
        canManageRelay ? (
          control
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
            <TooltipPopup side="top">
              Your session does not have permission to manage T3 Connect access.
            </TooltipPopup>
          </Tooltip>
        )
      }
    />
  );
}
