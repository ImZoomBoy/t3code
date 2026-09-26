import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";

/**
 * Stands in for a user message a fleet wake sent (`fleetWake` on the message):
 * one muted line that expands to the prompt, so a supervisor waking its agent
 * never reads as something the user typed.
 */
export function FleetNoticeTimelineRow({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div>
      <div className="-ms-1">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          onClick={() => setExpanded((value) => !value)}
        >
          Fleet notice
          <Icon aria-hidden="true" />
        </Button>
      </div>
      {expanded ? (
        <p className="mt-1 whitespace-pre-wrap break-words border-s border-border ps-3 text-muted-foreground text-xs">
          {text}
        </p>
      ) : null}
    </div>
  );
}
