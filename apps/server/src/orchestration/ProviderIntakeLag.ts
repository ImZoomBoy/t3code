/**
 * ProviderIntakeLagService - how far provider event intake runs behind the
 * provider stream, per thread.
 *
 * Runtime ingestion applies every provider event of every thread on one
 * serial worker, so the projection a client reads can trail what the
 * provider is doing. Ingestion records each event as it is queued and again
 * once it is applied. Readers use it to tell a quiet thread from one whose
 * view is behind: the session reaper refuses to stop a session whose events
 * are still queued, and the shell snapshot reports the backlog so a client
 * can tell its view is stale. In memory only; a restart starts empty, which
 * matches the empty queue.
 *
 * @module ProviderIntakeLagService
 */
import * as Context from "effect/Context";
import { type ProviderIntakeBacklog, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export interface ThreadIntakeLag {
  readonly pendingEvents: number;
  /** When the oldest event still waiting was queued, or null if none waits. */
  readonly oldestPendingAtMs: number | null;
  /** When the last provider event for the thread was queued. */
  readonly lastEventAtMs: number | null;
}

export class ProviderIntakeLagService extends Context.Service<
  ProviderIntakeLagService,
  {
    /** A provider event for the thread entered the intake queue at `atMs`. */
    readonly recordQueued: (threadId: string, atMs: number) => void;
    /** The oldest queued event for the thread was applied. */
    readonly recordApplied: (threadId: string) => void;
    /**
     * The thread's session ended or the thread was deleted: drop its last
     * event time. Events still queued keep their own entries until applied.
     */
    readonly forgetThread: (threadId: string) => void;
    readonly forThread: (threadId: string) => ThreadIntakeLag;
    /**
     * The backlog in its wire shape. With `behindForMs`, only threads whose
     * oldest queued event has waited that long at `nowMs`.
     */
    readonly snapshot: (options?: {
      readonly behindForMs: number;
      readonly nowMs: number;
    }) => ProviderIntakeBacklog;
  }
>()("t3/orchestration/ProviderIntakeLag/ProviderIntakeLagService") {}

function make(): ProviderIntakeLagService["Service"] {
  // Per thread, the queue times of events not yet applied, oldest first. The
  // intake worker applies events in queue order, so the front is the oldest.
  const pendingByThreadId = new Map<string, number[]>();
  const lastEventAtByThreadId = new Map<string, number>();

  return {
    recordQueued: (threadId, atMs) => {
      const pending = pendingByThreadId.get(threadId);
      if (pending) pending.push(atMs);
      else pendingByThreadId.set(threadId, [atMs]);
      lastEventAtByThreadId.set(threadId, atMs);
    },
    recordApplied: (threadId) => {
      const pending = pendingByThreadId.get(threadId);
      if (!pending) return;
      pending.shift();
      if (pending.length === 0) pendingByThreadId.delete(threadId);
    },
    forgetThread: (threadId) => {
      lastEventAtByThreadId.delete(threadId);
    },
    forThread: (threadId) => {
      const pending = pendingByThreadId.get(threadId);
      return {
        pendingEvents: pending?.length ?? 0,
        oldestPendingAtMs: pending?.[0] ?? null,
        lastEventAtMs: lastEventAtByThreadId.get(threadId) ?? null,
      };
    },
    snapshot: (options) => {
      const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
      const threads = Array.from(pendingByThreadId, ([threadId, pending]) => ({
        threadId,
        pendingEvents: pending.length,
        oldestPendingAtMs: pending[0]!,
      })).filter(
        (thread) =>
          options === undefined || options.nowMs - thread.oldestPendingAtMs >= options.behindForMs,
      );
      const oldestPendingAtMs =
        threads.length === 0 ? null : Math.min(...threads.map((t) => t.oldestPendingAtMs));
      return {
        pendingEvents: threads.reduce((sum, thread) => sum + thread.pendingEvents, 0),
        oldestPendingAt: oldestPendingAtMs === null ? null : iso(oldestPendingAtMs),
        threads: threads.map((thread) => ({
          threadId: ThreadId.make(thread.threadId),
          pendingEvents: thread.pendingEvents,
          oldestPendingAt: iso(thread.oldestPendingAtMs),
        })),
      };
    },
  };
}

export const layer = Layer.effect(ProviderIntakeLagService, Effect.sync(make));

/** A thread counts as behind once its oldest queued event has waited this long. */
const BEHIND_FOR_MS = 5_000;

/**
 * The shell stream's provider-intake items: the threads that are behind, once
 * at once and then whenever that set or its oldest waiting times change. A
 * healthy intake sends one empty item and nothing more.
 */
export const behindBacklogChanges = (lag: ProviderIntakeLagService["Service"]) =>
  Stream.tick("2 seconds").pipe(
    Stream.mapEffect(() =>
      Clock.currentTimeMillis.pipe(
        Effect.map((nowMs) => lag.snapshot({ behindForMs: BEHIND_FOR_MS, nowMs })),
      ),
    ),
    Stream.changesWith((previous, next) => backlogKey(previous) === backlogKey(next)),
    Stream.map((backlog) => ({ kind: "provider-intake" as const, backlog })),
  );

function backlogKey(backlog: ProviderIntakeBacklog): string {
  return backlog.threads.map((thread) => `${thread.threadId}@${thread.oldestPendingAt}`).join(",");
}
