import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * The pull request refreshes a server sends each subscriber: every revision set after it
 * subscribes, and not the current one. A client reloads its open reads on each value, and a reader
 * that has just subscribed is already reading fresh data.
 */
export const pullRequestRefreshChanges = (
  revision: SubscriptionRef.SubscriptionRef<number>,
): Stream.Stream<number> => SubscriptionRef.changes(revision).pipe(Stream.drop(1));
