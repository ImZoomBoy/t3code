import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const writeJson = Effect.fn(function* (filePath: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, typeof value === "string" ? value : encodeJson(value));
});

const writeSkill = Effect.fn(function* (skillsDir: string, directoryName: string) {
  const path = yield* Path.Path;
  yield* writeJson(
    path.join(skillsDir, directoryName, "SKILL.md"),
    ["---", `description: The ${directoryName} skill.`, "---", "", "# Body"].join("\n"),
  );
});

interface PluginInstall {
  readonly id: string;
  readonly skills?: ReadonlyArray<string>;
  /** `null` writes no `plugin.json`; a string is written verbatim. */
  readonly manifest?: unknown;
  readonly version?: string;
  readonly projectPath?: string;
}

/**
 * Lay out a made-up Claude config directory the way `claude plugin install`
 * does: one versioned folder per plugin under `plugins/cache`, and an
 * `installed_plugins.json` pointing at each.
 */
const makeClaudeHome = Effect.fn(function* (
  plugins: ReadonlyArray<PluginInstall>,
  /** Entries written into the install list as they are, whatever their shape. */
  rawInstalled: Record<string, unknown> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-plugin-skills-" });
  const configDir = path.join(tempDir, "claude-home");
  const workspace = path.join(tempDir, "workspace");
  yield* fs.makeDirectory(workspace, { recursive: true });

  const installed: Record<string, Array<Record<string, string>>> = {};
  const installPaths: Record<string, string> = {};
  for (const plugin of plugins) {
    const separator = plugin.id.lastIndexOf("@");
    const name = plugin.id.slice(0, separator);
    const marketplace = plugin.id.slice(separator + 1);
    const version = plugin.version ?? "1.0.0";
    const installPath = path.join(configDir, "plugins", "cache", marketplace, name, version);
    yield* fs.makeDirectory(installPath, { recursive: true });
    if (plugin.manifest !== null) {
      yield* writeJson(
        path.join(installPath, ".claude-plugin", "plugin.json"),
        plugin.manifest ?? { name, description: "A made-up plugin." },
      );
    }
    for (const skill of plugin.skills ?? ["hello"]) {
      yield* writeSkill(path.join(installPath, "skills"), skill);
    }
    (installed[plugin.id] ??= []).push({
      scope: plugin.projectPath ? "project" : "user",
      installPath,
      version,
      ...(plugin.projectPath ? { projectPath: plugin.projectPath } : {}),
    });
    installPaths[`${plugin.id}#${version}`] = installPath;
  }
  yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { ...installed, ...rawInstalled },
  });

  return {
    configDir,
    workspace,
    installPath: (id: string, version = "1.0.0") => installPaths[`${id}#${version}`] ?? "",
    userSettings: (value: unknown) => writeJson(path.join(configDir, "settings.json"), value),
    projectSettings: (value: unknown) =>
      writeJson(path.join(workspace, ".claude", "settings.json"), value),
    localSettings: (value: unknown) =>
      writeJson(path.join(workspace, ".claude", "settings.local.json"), value),
  };
});

const names = (skills: ReadonlyArray<{ readonly name: string }>) =>
  skills.map((skill) => skill.name);

it.layer(NodeServices.layer)("discoverClaudeSkills plugin skills", (it) => {
  it.effect("lists the skills of an installed, enabled plugin under plugin:skill", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([{ id: "alpha@market", skills: ["hello", "review"] }]);
      yield* writeSkill(path.join(home.configDir, "skills"), "mine");
      yield* home.userSettings({ enabledPlugins: { "alpha@market": true } });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      assert.deepEqual(skills, [
        {
          name: "alpha:hello",
          path: path.join(home.installPath("alpha@market"), "skills", "hello", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          description: "The hello skill.",
        },
        {
          name: "alpha:review",
          path: path.join(home.installPath("alpha@market"), "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          description: "The review skill.",
        },
        {
          name: "mine",
          path: path.join(home.configDir, "skills", "mine", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "The mine skill.",
        },
      ]);
    }),
  );

  it.effect("hides a disabled plugin and one enabledPlugins does not name", () =>
    Effect.gen(function* () {
      const home = yield* makeClaudeHome([
        { id: "alpha@market" },
        { id: "beta@market" },
        { id: "gamma@market" },
      ]);
      yield* home.userSettings({ enabledPlugins: { "alpha@market": true, "beta@market": false } });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      assert.deepEqual(names(skills), ["alpha:hello"]);
    }),
  );

  it.effect("lets project settings outrank user settings, and local settings outrank both", () =>
    Effect.gen(function* () {
      const home = yield* makeClaudeHome([
        { id: "alpha@market" },
        { id: "beta@market" },
        { id: "gamma@market" },
      ]);
      yield* home.userSettings({
        enabledPlugins: { "alpha@market": true, "beta@market": false, "gamma@market": false },
      });
      yield* home.projectSettings({
        enabledPlugins: { "beta@market": true, "gamma@market": true },
      });
      // A value the CLI does not read as a switch leaves the earlier one alone.
      yield* home.localSettings({
        enabledPlugins: { "alpha@market": false, "gamma@market": "yes" },
      });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      assert.deepEqual(names(skills), ["beta:hello", "gamma:hello"]);
    }),
  );

  it.effect("keeps ordinary skills when installed_plugins.json is malformed or missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([{ id: "alpha@market" }]);
      const installedPath = path.join(home.configDir, "plugins", "installed_plugins.json");
      yield* writeSkill(path.join(home.configDir, "skills"), "mine");
      yield* home.userSettings({ enabledPlugins: { "alpha@market": true } });
      // Control: the fixture is one a healthy file would list a plugin from.
      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace)),
        ["alpha:hello", "mine"],
      );

      yield* fs.writeFileString(installedPath, "{ not json");
      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace)),
        ["mine"],
      );

      yield* writeJson(installedPath, { version: 2, plugins: [] });
      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace)),
        ["mine"],
      );

      yield* fs.remove(installedPath);
      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace)),
        ["mine"],
      );
    }),
  );

  it.effect("skips only the broken plugin when one install entry or manifest is malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Entries of the wrong shape sit beside the good ones: a string, an
      // entry with no path, and a plugin whose installs are not a list.
      const home = yield* makeClaudeHome(
        [
          { id: "alpha@market" },
          { id: "broken-manifest@market", manifest: "{ not json" },
          { id: "gone@market" },
          { id: "no-manifest@market", manifest: null },
          { id: "no-skills@market", skills: [] },
        ],
        {
          "bad-entry@market": ["nope", { scope: "user" }],
          "bad-list@market": { installPath: 3 },
        },
      );
      yield* fs.remove(home.installPath("gone@market"), { recursive: true });
      yield* writeSkill(path.join(home.configDir, "skills"), "mine");
      yield* home.userSettings({
        enabledPlugins: {
          "alpha@market": true,
          "broken-manifest@market": true,
          "gone@market": true,
          "no-manifest@market": true,
          "no-skills@market": true,
          "bad-entry@market": true,
          "bad-list@market": true,
          "never-installed@market": true,
        },
      });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      // Claude Code refuses a plugin whose plugin.json does not parse, and
      // names one with no plugin.json after its id.
      assert.deepEqual(names(skills), ["alpha:hello", "mine", "no-manifest:hello"]);
    }),
  );

  it.effect("ignores enabledPlugins in a settings file that does not parse", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([{ id: "alpha@market" }, { id: "beta@market" }]);
      yield* writeSkill(path.join(home.configDir, "skills"), "mine");
      yield* home.userSettings({ enabledPlugins: { "alpha@market": true } });
      yield* home.projectSettings("{ enabledPlugins: nope");
      yield* home.localSettings({ enabledPlugins: ["beta@market"] });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      assert.deepEqual(names(skills), ["alpha:hello", "mine"]);
    }),
  );

  it.effect("names the skills after plugin.json and reads the folders it adds", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([
        {
          id: "alpha@market",
          manifest: { name: "renamed", skills: ["./extra", "../outside"] },
        },
        { id: "beta@market", manifest: { name: "beta", skills: "./custom" } },
      ]);
      yield* writeSkill(path.join(home.installPath("alpha@market"), "extra"), "more");
      yield* writeSkill(path.join(home.installPath("alpha@market"), "..", "outside"), "escaped");
      yield* writeSkill(path.join(home.installPath("beta@market"), "custom"), "bespoke");
      yield* home.userSettings({
        enabledPlugins: { "alpha@market": true, "beta@market": true },
      });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      assert.deepEqual(names(skills), [
        "beta:bespoke",
        "beta:hello",
        "renamed:hello",
        "renamed:more",
      ]);
    }),
  );

  it.effect("loads a project-scoped install only inside its project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([]);
      const elsewhere = path.join(path.dirname(home.workspace), "elsewhere");
      const nested = path.join(home.workspace, "packages", "app");
      yield* fs.makeDirectory(elsewhere, { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });
      const install = (projectPath: string) => ({
        scope: "project",
        installPath: path.join(home.configDir, "plugins", "cache", "market", "alpha", "1.0.0"),
        version: "1.0.0",
        projectPath,
      });
      yield* writeSkill(path.join(install("").installPath, "skills"), "hello");
      const writeInstalled = (projectPath: string) =>
        writeJson(path.join(home.configDir, "plugins", "installed_plugins.json"), {
          version: 2,
          plugins: { "alpha@market": [install(projectPath)] },
        });
      yield* home.userSettings({ enabledPlugins: { "alpha@market": true } });

      yield* writeInstalled(home.workspace);
      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace)),
        ["alpha:hello"],
      );
      assert.deepEqual(names(yield* discoverClaudeSkills({ homePath: home.configDir }, nested)), [
        "alpha:hello",
      ]);
      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, elsewhere)),
        [],
      );
      assert.deepEqual(names(yield* discoverClaudeSkills({ homePath: home.configDir })), []);
    }),
  );

  it.effect("uses the first install entry that applies to the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([
        { id: "alpha@market", version: "2.0.0", skills: ["newer"], projectPath: "placeholder" },
        { id: "alpha@market", version: "1.0.0", skills: ["older"] },
      ]);
      const installedPath = path.join(home.configDir, "plugins", "installed_plugins.json");
      const elsewhere = path.join(path.dirname(home.workspace), "elsewhere");
      yield* fs.makeDirectory(elsewhere, { recursive: true });
      yield* fs.writeFileString(
        installedPath,
        (yield* fs.readFileString(installedPath)).replace(
          '"placeholder"',
          encodeJson(home.workspace),
        ),
      );
      yield* home.userSettings({ enabledPlugins: { "alpha@market": true } });

      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace)),
        ["alpha:newer"],
      );
      assert.deepEqual(
        names(yield* discoverClaudeSkills({ homePath: home.configDir }, elsewhere)),
        ["alpha:older"],
      );
    }),
  );

  it.effect("keeps the first enabled plugin when two share a name", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([
        { id: "alpha@one", skills: ["hello", "only-one"] },
        { id: "alpha@two", skills: ["hello", "only-two"] },
      ]);
      yield* home.userSettings({ enabledPlugins: { "alpha@two": true, "alpha@one": true } });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      assert.deepEqual(names(skills), ["alpha:hello", "alpha:only-one", "alpha:only-two"]);
      assert.equal(
        skills[0]?.path,
        path.join(home.installPath("alpha@two"), "skills", "hello", "SKILL.md"),
      );
    }),
  );

  it.effect("does not apply skillOverrides to a plugin skill", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeClaudeHome([{ id: "alpha@market" }]);
      yield* writeSkill(path.join(home.configDir, "skills"), "mine");
      yield* home.userSettings({
        enabledPlugins: { "alpha@market": true },
        skillOverrides: { "alpha:hello": "off", hello: "off", mine: "off" },
      });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["alpha:hello", true],
          ["mine", false],
        ],
      );
    }),
  );

  it.effect("sends a picked plugin skill as the /plugin:skill command", () =>
    Effect.gen(function* () {
      const home = yield* makeClaudeHome([{ id: "alpha@market" }]);
      yield* home.userSettings({ enabledPlugins: { "alpha@market": true } });

      const skills = yield* discoverClaudeSkills({ homePath: home.configDir }, home.workspace);
      const dispatch = planClaudeSkillDispatch(
        "$alpha:hello tidy the header",
        new Set(names(skills)),
      );

      assert.deepEqual(dispatch, {
        leadingText: undefined,
        commandText: "/alpha:hello tidy the header",
        skillName: "alpha:hello",
      });
    }),
  );
});
