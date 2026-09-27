// Stand-in process tree for sessionProcessJob.test.ts. Every process appends
// "<role> <pid>" to $SESSION_TREE_DIR/pids, then stays up until it is ended.
//
//   host      a T3 Code server: installs the hook and starts a marked provider
//   provider  a provider CLI: runs a shell command
//   shell     starts a dev server in the background and exits, like `bash -c "x &"`,
//             so the dev server has no living parent for `taskkill /T` to follow
//   devserver started detached, so on Windows it leaves every libuv job
//   watcher   the dev server's own child
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const role = process.argv[2] ?? "provider";
const dir = process.env.SESSION_TREE_DIR;
NodeFS.appendFileSync(NodePath.join(dir, "pids"), `${role} ${process.pid}\n`);

const start = (childRole, options = {}) =>
  NodeChildProcess.spawn(process.execPath, [import.meta.filename, childRole], {
    stdio: "ignore",
    ...options,
  });

if (role === "host") {
  const { installSessionProcessJobs, sessionProcessJobEnv } =
    await import("../../process/sessionProcessJob.ts");
  installSessionProcessJobs();
  start("provider", { env: { ...process.env, ...sessionProcessJobEnv } });
  // The test ends this process: by asking it to exit, or by terminating it.
  process.stdin.on("data", () => process.exit(0));
} else if (role === "provider") {
  start("shell");
} else if (role === "shell") {
  start("devserver", { detached: true }).once("spawn", () => process.exit(0));
} else if (role === "devserver") {
  start("watcher");
}
setInterval(() => {}, 60_000);
