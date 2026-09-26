import type { OrchestrationMessage } from "@t3tools/contracts";

/**
 * The latest user message the user sent. A fleet wake (`fleetWake` on the
 * message) is First Mate waking its own agent, so it is skipped. The server
 * applies the same rule to a thread's `latestUserMessageAt`.
 */
export function findLatestUserSentMessage<
  Message extends Pick<OrchestrationMessage, "role" | "fleetWake">,
>(messages: ReadonlyArray<Message>): Message | undefined {
  return messages.findLast((message) => message.role === "user" && message.fleetWake !== true);
}
