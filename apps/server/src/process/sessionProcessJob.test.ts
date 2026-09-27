// @effect-diagnostics nodeBuiltinImport:off - the subject patches node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import {
  installSessionProcessJobs,
  restoreSessionProcessJobs,
  SESSION_PROCESS_JOB_ENV,
  sessionProcessJobEnv,
} from "./sessionProcessJob.ts";

const fixture = NodePath.join(
  import.meta.dirname,
  "../provider/testFixtures/sessionProcessTree.mjs",
);
const TREE = ["provider", "devserver", "watcher"] as const;
/** Every role that records itself; the shell exits on its own. */
const ALL = [...TREE, "shell"] as const;

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readTree = (dir: string): Map<string, number> => {
  const file = NodePath.join(dir, "pids");
  const lines = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8").trim().split("\n") : [];
  return new Map(
    lines.filter(Boolean).map((line) => {
      const [role, pid] = line.split(" ");
      return [role!, Number(pid)] as const;
    }),
  );
};

// The processes under test are real, so these wait on the operating system,
// checking every 25 ms. Both are bounded so a regression fails with the
// survivors named, not a hang.
const poll = (done: () => boolean, attempts: number) =>
  Effect.sync(done).pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("not yet"))),
    Effect.retry({ schedule: Schedule.spaced("25 millis"), times: attempts }),
    Effect.ignore,
  );

const waitForTree = (dir: string, roles: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* poll(() => roles.every((role) => readTree(dir).has(role)), 600);
    const tree = readTree(dir);
    expect([...tree.keys()].toSorted()).toEqual([...roles].toSorted());
    return tree;
  });

/** Roles from `tree` still running once everything has had time to end. */
const survivorsOf = (tree: Map<string, number>) =>
  Effect.gen(function* () {
    const pids = TREE.map((role) => tree.get(role)!);
    yield* poll(() => pids.every((pid) => !isRunning(pid)), 200);
    return TREE.filter((role) => isRunning(tree.get(role)!));
  });

const started: Array<string> = [];
const makeTreeDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-job-"));
  started.push(dir);
  return dir;
};

afterEach(() => {
  restoreSessionProcessJobs();
  // Only processes this file started, by the pids they recorded.
  for (const dir of started.splice(0)) {
    for (const pid of readTree(dir).values()) {
      if (isRunning(pid)) process.kill(pid);
    }
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("session process jobs", () => {
  it("gives a marked spawn a job, hides the mark, and ends the job when the process exits", async () => {
    const created: Array<number> = [];
    const ended: Array<number> = [];
    installSessionProcessJobs("win32", (pid) => {
      created.push(pid);
      return { end: () => ended.push(pid) };
    });

    const run = (env: NodeJS.ProcessEnv) =>
      new Promise<{ pid: number; seen: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          ["-e", `process.stdout.write(String(process.env.${SESSION_PROCESS_JOB_ENV}))`],
          { env },
        );
        let seen = "";
        child.stdout.on("data", (chunk) => (seen += chunk));
        child.on("error", reject);
        child.on("close", () => resolve({ pid: child.pid!, seen }));
      });

    const marked = await run({ ...process.env, ...sessionProcessJobEnv });
    expect(marked.seen).toBe("undefined");
    expect(created).toEqual([marked.pid]);
    expect(ended).toEqual([marked.pid]);

    await run(process.env);
    expect(created).toEqual([marked.pid]);
  });

  it("is not installed off Windows", () => {
    expect(installSessionProcessJobs("linux")).toBe(false);
    expect(installSessionProcessJobs("darwin")).toBe(false);
  });

  // Source checks, because an upstream merge that drops one of these lines
  // leaves every other test green and that provider's trees running again.
  // Only the ACP spawn is exercised end to end below.
  it("is installed by the server entry point and marked by every session spawn", () => {
    const read = (relative: string) =>
      NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", relative), "utf8");
    const bin = read("bin.ts");
    expect(bin.slice(bin.indexOf("isEntrypoint({"))).toContain("installSessionProcessJobs();");
    for (const site of [
      "provider/Layers/ClaudeAdapter.ts",
      "provider/Layers/CodexSessionRuntime.ts",
      "provider/acp/AcpSessionRuntime.ts",
      "provider/opencodeRuntime.ts",
    ]) {
      expect(read(site), site).toContain("...sessionProcessJobEnv");
    }
  });

  describe.runIf(HostProcessPlatform.defaultValue() === "win32")(
    "on Windows, with real processes",
    () => {
      it.live("a stopped session ends its provider, its child and its grandchild", () =>
        Effect.gen(function* () {
          installSessionProcessJobs();
          const dir = makeTreeDir();
          const session = yield* Scope.make();
          // The real session spawn path, with a provider that starts a tree.
          yield* AcpSessionRuntime.make({
            spawn: {
              command: process.execPath,
              args: [fixture, "provider"],
              env: { SESSION_TREE_DIR: dir },
            },
            cwd: dir,
            clientInfo: { name: "t3-test", version: "0.0.0" },
            authMethodId: "test",
          }).pipe(Scope.provide(session));
          const tree = yield* waitForTree(dir, ALL);

          yield* Scope.close(session, Exit.void);

          expect(yield* survivorsOf(tree)).toEqual([]);
        }).pipe(Effect.provide(NodeServices.layer)),
      );

      for (const route of ["exits", "crashes"] as const) {
        it.live(`the server ${route} and its sessions' trees end with it`, () =>
          Effect.gen(function* () {
            const dir = makeTreeDir();
            const host = NodeChildProcess.spawn(process.execPath, [fixture, "host"], {
              env: { ...process.env, SESSION_TREE_DIR: dir },
              stdio: ["pipe", "ignore", "inherit"],
            });
            const tree = yield* waitForTree(dir, ["host", ...ALL]);
            const gone = new Promise((resolve) => host.once("exit", resolve));

            if (route === "exits") host.stdin.write("exit\n");
            else host.kill();
            yield* Effect.promise(() => gone);

            expect(yield* survivorsOf(tree)).toEqual([]);
          }),
        );
      }
    },
  );
});
