import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderIntakeLagService } from "../../orchestration/ProviderIntakeLag.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const intakeLag = yield* ProviderIntakeLagService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        if (now - lastSeenMs < inactivityThresholdMs) {
          continue;
        }

        // The projection can trail the provider (see ProviderIntakeLag). A
        // session whose provider events are still queued has a view that is
        // behind, so nothing read from it can prove the session idle.
        const intake = intakeLag.forThread(binding.threadId);
        if (intake.pendingEvents > 0) {
          yield* Effect.logInfo("provider.session.reaper.skipped-intake-behind", {
            threadId: binding.threadId,
            pendingEvents: intake.pendingEvents,
            oldestPendingAtMs: intake.oldestPendingAtMs,
          });
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        // Ingestion updates this timestamp alongside activeTurnId when a turn
        // settles. Long turns must get a full idle window after that transition,
        // even though the binding was last touched when the turn was sent. Any
        // provider event counts as activity too: a streaming turn is not idle.
        const lastActivityMs = Math.max(
          lastSeenMs,
          Date.parse(thread?.session?.updatedAt ?? binding.lastSeenAt),
          intake.lastEventAtMs ?? 0,
        );
        const idleDurationMs = now - lastActivityMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }
        const projectedStatus = thread?.session?.status;
        if (projectedStatus === "starting" || projectedStatus === "running") {
          yield* Effect.logDebug("provider.session.reaper.skipped-busy-session", {
            threadId: binding.threadId,
            status: projectedStatus,
            idleDurationMs,
          });
          continue;
        }
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        // Last, the provider service checks the adapter's own live session
        // and stops it only if idle, under the lock a turn start takes. Its
        // state is current even when the projection is not.
        const reaped = yield* providerService.stopIdleSession({ threadId: binding.threadId }).pipe(
          Effect.tap((outcome) =>
            outcome.stopped
              ? Effect.logInfo("provider.session.reaped", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  idleDurationMs,
                  reason: "inactivity_threshold",
                  lastSeenAt: binding.lastSeenAt,
                  projectedStatus,
                  projectedUpdatedAt: thread?.session?.updatedAt,
                  lastProviderEventAtMs: intake.lastEventAtMs,
                })
              : Effect.logInfo("provider.session.reaper.skipped-live-session", {
                  threadId: binding.threadId,
                  reason: outcome.reason,
                  projectedStatus,
                  idleDurationMs,
                }),
          ),
          Effect.map((outcome) => outcome.stopped),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
