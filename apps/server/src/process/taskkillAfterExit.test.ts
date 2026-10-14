// @effect-diagnostics nodeBuiltinImport:off - the test records what node:child_process starts.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect } from "vite-plus/test";

interface InternalChildProcessPrototype {
  spawn: (this: unknown, options: { readonly file?: string }) => unknown;
}

/** Runs `effect` while recording the executable of every child process it starts. */
const recordingStarts = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const target = NodeChildProcess.ChildProcess
        .prototype as unknown as InternalChildProcessPrototype;
      const inner = target.spawn;
      const files: Array<string> = [];
      target.spawn = function record(this: unknown, options) {
        files.push(options.file ?? "");
        return inner.call(this, options);
      };
      return { files, restore: () => (target.spawn = inner) };
    }),
    (recorder) => Effect.map(effect, (value) => ({ value, files: recorder.files })),
    (recorder) => Effect.sync(recorder.restore),
  );

const runNode = (script: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", script], { stdout: "ignore", stderr: "ignore" }),
      );
      return yield* child.exitCode;
    }),
  );

// Effect's spawner stops a process tree on Windows with `taskkill /pid <pid> /T /F`.
// patches/@effect__platform-node-shared@4.0.0-rc.115.patch carries the guard from
// Effect 4.0.4: no `taskkill` once the leader has exited, because its pid may
// already belong to an unrelated process. Without it, every child that exits
// non-zero started two `taskkill` runs against its dead pid.
describe.runIf(HostProcessPlatform.defaultValue() === "win32")("taskkill on Windows", () => {
  it.live("does not run for a child that already exited with a failure", () =>
    Effect.gen(function* () {
      const { value: code, files } = yield* recordingStarts(runNode("process.exit(3)"));
      expect(code).toBe(3);
      expect(files.filter((file) => file === "taskkill")).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("still stops a child that is running when its scope closes", () =>
    Effect.gen(function* () {
      const { files } = yield* recordingStarts(
        Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            yield* spawner.spawn(
              ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                stdout: "ignore",
                stderr: "ignore",
              }),
            );
          }),
        ),
      );
      expect(files.filter((file) => file === "taskkill")).toEqual(["taskkill"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
