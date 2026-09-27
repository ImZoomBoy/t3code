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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ThreadIntakeLag {
  readonly pendingEvents: number;
  /** When the oldest event still waiting was queued, or null if none waits. */
  readonly oldestPendingAtMs: number | null;
  /** When the last provider event for the thread was queued. */
  readonly lastEventAtMs: number | null;
}

export interface IntakeLagSnapshot {
  readonly pendingEvents: number;
  readonly oldestPendingAtMs: number | null;
  readonly threads: ReadonlyArray<{
    readonly threadId: string;
    readonly pendingEvents: number;
    readonly oldestPendingAtMs: number;
  }>;
}

export class ProviderIntakeLagService extends Context.Service<
  ProviderIntakeLagService,
  {
    /** A provider event for the thread entered the intake queue at `atMs`. */
    readonly recordQueued: (threadId: string, atMs: number) => void;
    /** The oldest queued event for the thread was applied. */
    readonly recordApplied: (threadId: string) => void;
    readonly forThread: (threadId: string) => ThreadIntakeLag;
    readonly snapshot: () => IntakeLagSnapshot;
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
    forThread: (threadId) => {
      const pending = pendingByThreadId.get(threadId);
      return {
        pendingEvents: pending?.length ?? 0,
        oldestPendingAtMs: pending?.[0] ?? null,
        lastEventAtMs: lastEventAtByThreadId.get(threadId) ?? null,
      };
    },
    snapshot: () => {
      const threads = Array.from(pendingByThreadId, ([threadId, pending]) => ({
        threadId,
        pendingEvents: pending.length,
        oldestPendingAtMs: pending[0]!,
      }));
      return {
        pendingEvents: threads.reduce((sum, thread) => sum + thread.pendingEvents, 0),
        oldestPendingAtMs:
          threads.length === 0 ? null : Math.min(...threads.map((t) => t.oldestPendingAtMs)),
        threads,
      };
    },
  };
}

export const layer = Layer.effect(ProviderIntakeLagService, Effect.sync(make));
