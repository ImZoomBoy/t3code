// Stand-in process tree for sessionProcessJob.test.ts. Every process appends
// "<role> <pid>" to $SESSION_TREE_DIR/pids, then stays up until it is ended.
//
//   host      a T3 Code server: installs the hook and starts a marked provider
//   provider  a provider CLI: runs a shell command
//   opencode  an `opencode serve`: answers its health check, then acts as the provider
//   shell     starts a dev server in the background and exits, like `bash -c "x &"`,
//             so the dev server has no living parent for `taskkill /T` to follow.
//             $SESSION_TREE_SHELL_DELAY_MS holds it back before it does.
//   devserver started detached, so on Windows it leaves every libuv job
//   watcher   the dev server's own child
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const role = process.argv[2] ?? "provider";
const dir = process.env.SESSION_TREE_DIR;
NodeFS.appendFileSync(
  NodePath.join(dir, "pids"),
  `${role === "opencode" ? "provider" : role} ${process.pid}\n`,
);

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
} else if (role === "provider" || role === "opencode") {
  if (role === "opencode") {
    const server = NodeHttp.createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ healthy: true, version: "1.14.19" }));
    });
    server.listen(0, "127.0.0.1", () =>
      process.stdout.write(
        `opencode server listening on http://127.0.0.1:${server.address().port}\n`,
      ),
    );
  }
  start("shell");
} else if (role === "shell") {
  setTimeout(
    () => start("devserver", { detached: true }).once("spawn", () => process.exit(0)),
    Number(process.env.SESSION_TREE_SHELL_DELAY_MS ?? 0),
  );
} else if (role === "devserver") {
  start("watcher");
}
setInterval(() => {}, 60_000);
