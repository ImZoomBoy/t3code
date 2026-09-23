import type { FleetRole } from "@t3tools/contracts";

/**
 * How clients name and place First Mate's threads. Everything here keys off
 * `fleetRole`, never the title: a title carries only the work.
 */
export interface FleetThreadFields {
  readonly fleetRole?: FleetRole | null | undefined;
  readonly fleetRepo?: string | null | undefined;
}

export const FIRST_MATE_LABEL = "First Mate";

export function isFirstMateThread(thread: FleetThreadFields): boolean {
  return thread.fleetRole === "first-mate";
}

/** The role label a fleet thread shows, or null for an ordinary thread. */
export function fleetRoleLabel(thread: FleetThreadFields): string | null {
  switch (thread.fleetRole) {
    case "first-mate":
      return FIRST_MATE_LABEL;
    case "second-mate":
      return thread.fleetRepo ? `Second mate - ${thread.fleetRepo}` : "Second mate";
    case "worker":
      return "Worker";
    default:
      return null;
  }
}

const CLAUDE_FAMILY = /^(?:claude-)?(opus|sonnet|haiku|fable)((?:-\d+)*)$/i;
const EFFORT = /^(?:minimal|low|medium|high|xhigh|max)$/i;
// A model id as First Mate has written it into titles: a Claude family with a
// version and an optional bracketed context suffix, or a GPT id. The version
// is required so a title that ends in the plain word "opus" keeps it.
const MODEL_TOKEN =
  /^(?:(?:claude-)?(?:opus|sonnet|haiku|fable)(?:-\d+)+|gpt-\d[\w.-]*)(?:\[[^\]]*\])?$/i;
const LEADING_ROLE_TAG = /^\[(?:crewmate|first[ -]?mate|second[ -]?mate|worker)\]\s*/i;

/**
 * A model id as a person reads it: `claude-opus-5-5[1m]` becomes "Opus 5.5".
 * Any other id shows the provider catalog's name when the caller has one,
 * and otherwise the id without its bracketed suffix.
 */
export function formatModelDisplayName(model: string, catalogName?: string | null): string {
  const bare = model
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  const match = CLAUDE_FAMILY.exec(bare);
  if (match === null) return catalogName ?? bare;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  const version = match[2]!.split("-").filter(Boolean).join(".");
  return version ? `${family} ${version}` : family;
}

/**
 * The title a client shows for a thread. The First Mate thread is always
 * "First Mate". Any other title loses a leading fleet role tag such as
 * `[crewmate]` and a trailing model and effort such as `opus-5-5[1m] medium`,
 * which First Mate put into titles before it sent `fleetRole`. The model has
 * its own place on the row.
 */
export function threadDisplayTitle(thread: FleetThreadFields & { readonly title: string }): string {
  if (isFirstMateThread(thread)) return FIRST_MATE_LABEL;
  const words = thread.title.replace(LEADING_ROLE_TAG, "").trim().split(/\s+/);
  if (words.length > 1 && EFFORT.test(words.at(-1)!) && MODEL_TOKEN.test(words.at(-2) ?? "")) {
    words.splice(-2, 2);
  } else if (words.length > 1 && MODEL_TOKEN.test(words.at(-1)!)) {
    words.pop();
  }
  const stripped = words.join(" ");
  return stripped.length > 0 ? stripped : thread.title;
}
