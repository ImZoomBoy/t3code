// @effect-diagnostics nodeBuiltinImport:off - The test reads the workflow files on disk directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const workflow = (name: string) =>
  NodeFS.readFileSync(NodePath.join(repoRoot, ".github", "workflows", name), "utf8");
const runners = (source: string) =>
  [...source.matchAll(/^\s*runs-on:\s*(\S+)/gm)].map((match) => match[1]);

/**
 * The workflows a pull request waits on. This fork has no Blacksmith account,
 * so a job that names a Blacksmith runner stays queued and the pull request
 * never goes green. An upstream merge brings those labels back without a
 * conflict whenever upstream adds a job.
 */
describe("fork CI workflows", () => {
  it.each(["ci.yml", "mobile-fingerprint-check.yml"])(
    "%s runs every job on a GitHub-hosted runner",
    (name) => {
      const found = runners(workflow(name));
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((runner) => !/^(ubuntu|macos|windows)-/.test(runner!))).toEqual([]);
    },
  );

  it("ci.yml runs the fork feature check", () => {
    expect(workflow("ci.yml")).toContain("run: node scripts/check-fork-features.ts");
  });
});
