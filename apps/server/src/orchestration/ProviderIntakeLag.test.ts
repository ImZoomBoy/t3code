import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderIntakeLag from "./ProviderIntakeLag.ts";

it.effect("tells the shell stream which threads fall behind and when they catch up", () =>
  Effect.gen(function* () {
    const lag = yield* ProviderIntakeLag.ProviderIntakeLagService;
    lag.recordQueued("thread-busy", 0);
    const items = yield* ProviderIntakeLag.behindBacklogChanges(lag).pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild,
    );

    // At 0 s the event has not waited long enough; by 6 s it has.
    yield* TestClock.adjust("6 seconds");
    lag.recordApplied("thread-busy");
    yield* TestClock.adjust("2 seconds");

    const threads = Array.from(yield* Fiber.join(items)).map((item) =>
      item.backlog.threads.map((thread) => [thread.threadId, thread.oldestPendingAt]),
    );
    assert.deepStrictEqual(threads, [[], [["thread-busy", "1970-01-01T00:00:00.000Z"]], []]);
  }).pipe(Effect.provide(ProviderIntakeLag.layer)),
);
