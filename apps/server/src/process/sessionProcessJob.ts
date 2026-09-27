// @effect-diagnostics nodeBuiltinImport:off - the subject patches node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

/**
 * Every process a provider session starts, at any depth, ends with the session.
 *
 * ## Why Windows needs this
 *
 * Node puts each child it spawns in one job object per parent process, created
 * by libuv with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `BREAKAWAY_OK` and
 * `SILENT_BREAKAWAY_OK`. Silent breakaway means a process the child starts is in
 * no job at all. So when T3 Code stops a session, it ends the provider CLI, but a
 * dev server or file watcher the agent started through a shell keeps running
 * with no parent. The Effect spawner's `taskkill /T` does not reach it either:
 * that walks parent pids, and the shell between them has usually exited.
 *
 * ## What this does
 *
 * A session marks the spawn of its provider process with {@link SESSION_PROCESS_JOB_ENV}.
 * The hook below sees the mark on the one function every asynchronous spawn
 * funnels into, strips it so the provider never sees it, and puts the new
 * process in its own job: kill-on-close, and no breakaway of either kind. Every
 * process started under it then belongs to the job, whatever its depth, even a
 * node child spawned `detached` (libuv never asks for `CREATE_BREAKAWAY_FROM_JOB`).
 *
 * The job ends when the provider process exits. Every way T3 Code stops a
 * session (stop, reap, settle, restart) already ends that process, so each one
 * now ends its tree too. If the server itself exits or crashes, the job's only
 * handle closes with it, and kill-on-close ends the tree.
 *
 * The job only ever holds processes the session started. T3 Code's own
 * processes and other sessions' processes are never in it. It sets no CPU,
 * memory or priority limit.
 *
 * The assignment happens synchronously, in the same call that created the
 * process, before the provider has run any code that could start a child. That
 * is why this is a spawn hook rather than a step after the Effect spawner hands
 * back a handle, which only happens a tick later.
 *
 * ## Other platforms
 *
 * Windows only. The hook is not installed elsewhere, and the mark is inert.
 */
export const SESSION_PROCESS_JOB_ENV = "T3CODE_SESSION_PROCESS_JOB";

/** Spread into a session spawn's environment to give its process tree a job. */
export const sessionProcessJobEnv: { readonly [SESSION_PROCESS_JOB_ENV]: "1" } = {
  [SESSION_PROCESS_JOB_ENV]: "1",
};

const MARK = `${SESSION_PROCESS_JOB_ENV}=1`;

/** A job holding one session's process tree. `end` is safe to call twice. */
export interface SessionProcessJob {
  readonly end: () => void;
}

/** Creates a job and assigns `pid` to it, or returns `undefined` if Windows refused. */
export type CreateSessionProcessJob = (pid: number) => SessionProcessJob | undefined;

/**
 * Shape of the internal `ChildProcess.prototype.spawn` options bag. Node has
 * already turned `env` into `envPairs` here. `@types/node` does not describe it.
 */
interface InternalSpawnOptions {
  readonly envPairs?: ReadonlyArray<string> | undefined;
}

interface InternalChildProcess {
  readonly pid?: number | undefined;
  once(event: "exit", listener: () => void): unknown;
}

type InternalSpawn = (this: InternalChildProcess, options: InternalSpawnOptions) => unknown;

interface HookedSpawn extends InternalSpawn {
  readonly [installedMarker]?: true;
  readonly [innerMarker]?: InternalSpawn;
}

const installedMarker = Symbol.for("@t3tools/server/sessionProcessJob/installed");
const innerMarker = Symbol.for("@t3tools/server/sessionProcessJob/inner");

const prototype = (): { spawn: InternalSpawn } | undefined =>
  NodeChildProcess.ChildProcess?.prototype as unknown as { spawn: InternalSpawn } | undefined;

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: 144 bytes, with
// BasicLimitInformation.LimitFlags at offset 16.
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const JOB_OBJECT_LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

type Ffi = typeof import("ffi-rs");
type DataType = import("ffi-rs").DataType;
const KERNEL32 = "t3-session-job-kernel32";
let ffi: Ffi | undefined;

const loadFfi = (): Ffi => {
  if (ffi === undefined) {
    ffi = NodeModule.createRequire(import.meta.url)("ffi-rs") as Ffi;
    ffi.open({ library: KERNEL32, path: "kernel32.dll" });
  }
  return ffi;
};

/**
 * The Windows implementation, through kernel32. `ffi-rs` is loaded on first use,
 * through `require` because a Node single-executable cannot `import` an
 * external package.
 */
const createWindowsSessionProcessJob: CreateSessionProcessJob = (pid) => {
  const { DataType, load } = loadFfi();
  const handle = (value: bigint) => ({ type: DataType.BigInt, value });
  const call = (
    funcName: string,
    retType: DataType,
    params: ReadonlyArray<{ readonly type: DataType; readonly value: unknown }>,
  ): unknown =>
    load({
      library: KERNEL32,
      funcName,
      retType,
      paramsType: params.map((param) => param.type),
      paramsValue: params.map((param) => param.value),
    } as Parameters<Ffi["load"]>[0]);
  const closeHandle = (value: bigint) => call("CloseHandle", DataType.Boolean, [handle(value)]);

  // No security attributes, so the handle is not inheritable: a child holding
  // a copy would keep the job open after the server is gone.
  const job = call("CreateJobObjectW", DataType.BigInt, [handle(0n), handle(0n)]) as bigint;
  if (job === 0n) return undefined;

  const limits = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_FLAGS_OFFSET);
  const target = call("OpenProcess", DataType.BigInt, [
    { type: DataType.U32, value: PROCESS_SET_QUOTA | PROCESS_TERMINATE },
    { type: DataType.Boolean, value: false },
    { type: DataType.U32, value: pid },
  ]) as bigint;
  const assigned =
    target !== 0n &&
    call("SetInformationJobObject", DataType.Boolean, [
      handle(job),
      { type: DataType.I32, value: JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS },
      { type: DataType.U8Array, value: limits },
      { type: DataType.U32, value: limits.byteLength },
    ]) === true &&
    call("AssignProcessToJobObject", DataType.Boolean, [handle(job), handle(target)]) === true;
  if (target !== 0n) closeHandle(target);
  if (!assigned) {
    closeHandle(job);
    return undefined;
  }

  let open = true;
  return {
    end: () => {
      if (!open) return;
      open = false;
      call("TerminateJobObject", DataType.Boolean, [handle(job), { type: DataType.U32, value: 1 }]);
      closeHandle(job);
    },
  };
};

/**
 * Installs the hook. Runs once at the server's entry point; a second call is a
 * no-op. Returns whether it installed. The parameters are the test seam.
 */
export const installSessionProcessJobs = (
  // Runs at a process entry point, before any Effect runtime exists.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- no runtime yet
  platform: NodeJS.Platform = process.platform,
  createJob: CreateSessionProcessJob = createWindowsSessionProcessJob,
): boolean => {
  if (platform !== "win32") return false;
  const target = prototype();
  // Absent under runtimes that reimplement `node:child_process`, such as Bun.
  if (target === undefined || typeof target.spawn !== "function") return false;
  if ((target.spawn as HookedSpawn)[installedMarker] === true) return false;

  const inner = target.spawn;
  let warned = false;
  const hooked: HookedSpawn = Object.defineProperties(
    function spawnInSessionJob(this: InternalChildProcess, options: InternalSpawnOptions) {
      const envPairs = options.envPairs;
      if (envPairs === undefined || !envPairs.includes(MARK)) return inner.call(this, options);

      const result = inner.call(this, {
        ...options,
        envPairs: envPairs.filter((pair) => pair !== MARK),
      });
      const pid = this.pid;
      if (pid === undefined) return result;
      let job: SessionProcessJob | undefined;
      try {
        job = createJob(pid);
      } catch {
        job = undefined;
      }
      if (job === undefined) {
        // The session still runs; it just loses the cleanup. Say so once.
        if (!warned) {
          warned = true;
          process.emitWarning(
            `Could not give provider process ${pid} its own job object; processes it starts may outlive its session.`,
          );
        }
        return result;
      }
      this.once("exit", job.end);
      return result;
    },
    {
      [installedMarker]: { value: true },
      [innerMarker]: { value: inner },
    },
  );
  target.spawn = hooked;
  return true;
};

/** Takes the hook back off. Returns `false` when it is not the outermost patch. */
export const restoreSessionProcessJobs = (): boolean => {
  const target = prototype();
  if (target === undefined) return false;
  const current = target.spawn as HookedSpawn;
  const inner = current[innerMarker];
  if (current[installedMarker] !== true || inner === undefined) return false;
  target.spawn = inner;
  return true;
};
