// @effect-diagnostics nodeBuiltinImport:off - the subject patches node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

import type { ServerConfigIssue } from "@t3tools/contracts";

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
 * ## The start-up gap
 *
 * Node's `spawn` resumes the new process before it returns, so the provider is
 * already running when the hook assigns it, and a process it starts in that gap
 * is in no job. So right after the assignment, the hook takes one snapshot of
 * every process, finds the provider's descendants that are outside the job, and
 * assigns them too, repeating until a snapshot finds none. Anything they start
 * after that is in the job from creation.
 *
 * One case stays out of reach: a process started in the gap whose parent has
 * already exited when the snapshot runs. Nothing links it to the provider any
 * more. The gap runs from Node resuming the process to the assignment, which is
 * normally far shorter than a provider needs to start a process that starts
 * another and exits.
 *
 * ## If the job cannot be made
 *
 * The native binding loads when the hook is installed, not at the first
 * session, so the first spawn does not widen the gap and a broken build shows
 * at start-up. If it fails to load, sessions still run without jobs, and
 * {@link sessionProcessJobsUnavailable} says why so the server can report it.
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

/** Loads what {@link CreateSessionProcessJob} needs. Throws when it cannot. */
export type LoadSessionProcessJobs = () => CreateSessionProcessJob;

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
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

// SYSTEM_PROCESS_INFORMATION on 64-bit Windows, one entry per process.
const SYSTEM_PROCESS_INFORMATION_CLASS = 5;
const STATUS_INFO_LENGTH_MISMATCH = -1073741820; // 0xC0000004
const ENTRY_NEXT_OFFSET = 0x00;
const ENTRY_CREATE_TIME = 0x20;
const ENTRY_PROCESS_ID = 0x50;
const ENTRY_PARENT_PROCESS_ID = 0x58;
/** Bounds the gap sweep; each pass only repeats when the one before assigned something. */
const MAX_SWEEP_PASSES = 8;

type Ffi = typeof import("ffi-rs");
type DataType = import("ffi-rs").DataType;
const KERNEL32 = "t3-session-job-kernel32";
const NTDLL = "t3-session-job-ntdll";

interface ProcessEntry {
  readonly parentPid: number;
  readonly createTime: bigint;
}

/**
 * The Windows implementation, through kernel32 and ntdll. `ffi-rs` is loaded
 * through `require` because a Node single-executable cannot `import` an
 * external package.
 */
const loadWindowsSessionProcessJobs: LoadSessionProcessJobs = () => {
  const ffi = NodeModule.createRequire(import.meta.url)("ffi-rs") as Ffi;
  ffi.open({ library: KERNEL32, path: "kernel32.dll" });
  ffi.open({ library: NTDLL, path: "ntdll.dll" });
  const { DataType, load } = ffi;
  const handle = (value: bigint) => ({ type: DataType.BigInt, value });
  const call = (
    library: string,
    funcName: string,
    retType: DataType,
    params: ReadonlyArray<{ readonly type: DataType; readonly value: unknown }>,
  ): unknown =>
    load({
      library,
      funcName,
      retType,
      paramsType: params.map((param) => param.type),
      paramsValue: params.map((param) => param.value),
    } as Parameters<Ffi["load"]>[0]);
  const kernel32 = (
    funcName: string,
    retType: DataType,
    params: ReadonlyArray<{ readonly type: DataType; readonly value: unknown }>,
  ) => call(KERNEL32, funcName, retType, params);
  const closeHandle = (value: bigint) => kernel32("CloseHandle", DataType.Boolean, [handle(value)]);

  // No security attributes, so the handle is not inheritable: a child holding
  // a copy would keep the job open after the server is gone.
  const createJob = () =>
    kernel32("CreateJobObjectW", DataType.BigInt, [handle(0n), handle(0n)]) as bigint;

  const openProcess = (pid: number) =>
    kernel32("OpenProcess", DataType.BigInt, [
      {
        type: DataType.U32,
        value: PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
      },
      { type: DataType.Boolean, value: false },
      { type: DataType.U32, value: pid },
    ]) as bigint;

  /** Assigns `pid` unless it is already in `job`. Returns whether it assigned. */
  const assign = (job: bigint, pid: number): boolean => {
    const target = openProcess(pid);
    if (target === 0n) return false;
    try {
      const inJob = Buffer.alloc(4);
      const checked =
        kernel32("IsProcessInJob", DataType.Boolean, [
          handle(target),
          handle(job),
          { type: DataType.U8Array, value: inJob },
        ]) === true;
      if (checked && inJob.readUInt32LE() !== 0) return false;
      return (
        kernel32("AssignProcessToJobObject", DataType.Boolean, [handle(job), handle(target)]) ===
        true
      );
    } finally {
      closeHandle(target);
    }
  };

  let snapshotSize = 1 << 20;
  const snapshot = (): Map<number, ProcessEntry> => {
    const needed = Buffer.alloc(4);
    for (;;) {
      const buffer = Buffer.alloc(snapshotSize);
      const status = call(NTDLL, "NtQuerySystemInformation", DataType.I32, [
        { type: DataType.I32, value: SYSTEM_PROCESS_INFORMATION_CLASS },
        { type: DataType.U8Array, value: buffer },
        { type: DataType.U32, value: buffer.byteLength },
        { type: DataType.U8Array, value: needed },
      ]);
      if (status === STATUS_INFO_LENGTH_MISMATCH) {
        snapshotSize = needed.readUInt32LE() + (1 << 16);
        continue;
      }
      const processes = new Map<number, ProcessEntry>();
      if (status !== 0) return processes;
      for (let offset = 0; ;) {
        processes.set(Number(buffer.readBigUInt64LE(offset + ENTRY_PROCESS_ID)), {
          parentPid: Number(buffer.readBigUInt64LE(offset + ENTRY_PARENT_PROCESS_ID)),
          createTime: buffer.readBigUInt64LE(offset + ENTRY_CREATE_TIME),
        });
        const next = buffer.readUInt32LE(offset + ENTRY_NEXT_OFFSET);
        if (next === 0) return processes;
        offset += next;
      }
    }
  };

  /** Moves into `job` every descendant of `root` started before `root` joined it. */
  const sweep = (job: bigint, root: number) => {
    for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
      const processes = snapshot();
      const children = new Map<number, Array<number>>();
      for (const [pid, entry] of processes) {
        const siblings = children.get(entry.parentPid);
        if (siblings) siblings.push(pid);
        else children.set(entry.parentPid, [pid]);
      }
      let assigned = 0;
      const pending = [root];
      for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
        const parentCreated = processes.get(parent)?.createTime;
        if (parentCreated === undefined) continue;
        for (const pid of children.get(parent) ?? []) {
          // A parent pid can be reused: only a process younger than its
          // parent can be that parent's child.
          if (processes.get(pid)!.createTime < parentCreated) continue;
          pending.push(pid);
          if (assign(job, pid)) assigned++;
        }
      }
      if (assigned === 0) return;
    }
  };

  // Proves the binding works end to end, so a broken build fails here.
  const probe = createJob();
  if (probe === 0n) throw new Error("CreateJobObjectW failed.");
  closeHandle(probe);

  return (pid) => {
    const job = createJob();
    if (job === 0n) return undefined;

    const limits = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_FLAGS_OFFSET);
    const assigned =
      kernel32("SetInformationJobObject", DataType.Boolean, [
        handle(job),
        { type: DataType.I32, value: JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS },
        { type: DataType.U8Array, value: limits },
        { type: DataType.U32, value: limits.byteLength },
      ]) === true && assign(job, pid);
    if (!assigned) {
      closeHandle(job);
      return undefined;
    }
    sweep(job, pid);

    let open = true;
    return {
      end: () => {
        if (!open) return;
        open = false;
        kernel32("TerminateJobObject", DataType.Boolean, [
          handle(job),
          { type: DataType.U32, value: 1 },
        ]);
        closeHandle(job);
      },
    };
  };
};

let unavailableReason: string | undefined;

/**
 * Why session process jobs are off on this Windows server, or `undefined` when
 * they work or the platform does not use them. Set once, at install.
 */
export const sessionProcessJobsUnavailable = (): string | undefined => unavailableReason;

/** {@link sessionProcessJobsUnavailable} as a server config issue, so clients can show it. */
export const sessionProcessJobsIssues = (): ReadonlyArray<ServerConfigIssue> =>
  unavailableReason === undefined
    ? []
    : [
        {
          kind: "processes.session-jobs-unavailable",
          message: `Processes that agents start may keep running after their session stops. The Windows process cleanup did not load: ${unavailableReason}`,
        },
      ];

/**
 * Installs the hook. Runs once at the server's entry point; a second call is a
 * no-op. Returns whether it installed. The parameters are the test seam.
 */
export const installSessionProcessJobs = (
  // Runs at a process entry point, before any Effect runtime exists.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- no runtime yet
  platform: NodeJS.Platform = process.platform,
  loadJobs: LoadSessionProcessJobs = loadWindowsSessionProcessJobs,
): boolean => {
  if (platform !== "win32") return false;
  const target = prototype();
  // Absent under runtimes that reimplement `node:child_process`, such as Bun.
  if (target === undefined || typeof target.spawn !== "function") return false;
  if ((target.spawn as HookedSpawn)[installedMarker] === true) return false;

  let createJob: CreateSessionProcessJob;
  try {
    createJob = loadJobs();
  } catch (cause) {
    unavailableReason = cause instanceof Error ? cause.message : String(cause);
    // Still installed, so the mark keeps being stripped from provider spawns.
    createJob = () => undefined;
  }

  const inner = target.spawn;
  let warned = unavailableReason !== undefined;
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
  unavailableReason = undefined;
  return true;
};
