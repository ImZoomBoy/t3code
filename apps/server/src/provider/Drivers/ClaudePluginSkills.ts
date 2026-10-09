/**
 * ClaudePluginSkills — finds the skill folders of Claude Code plugins, so the
 * `$` picker can offer plugin skills beside user and project ones.
 *
 * Claude Code publishes a plugin skill as `<plugin>:<skill>` and runs it only
 * as `/<plugin>:<skill>`. Verified against CLI 2.1.296 in stream-json mode:
 * the bare `/<skill>` and `$<plugin>:<skill>` forms reach the model as prose.
 *
 * Every rule below was read off the CLI's init message against made-up
 * plugins in a temporary config directory:
 *
 *  - A plugin loads only when `enabledPlugins` holds `true` for its
 *    `<plugin>@<marketplace>` id. `false`, and an installed plugin the map
 *    does not name, stay unloaded.
 *  - `enabledPlugins` merges across user settings, then the workspace's
 *    `.claude/settings.json`, then its `.claude/settings.local.json`, later
 *    files winning per id. Unlike `skillOverrides`, a repository root's
 *    settings are not consulted from a nested cwd.
 *  - `plugins/installed_plugins.json` maps each id to a list of installs. An
 *    install that carries a `projectPath` loads only inside that project.
 *  - Skills come from `<installPath>/skills`, plus any folders `plugin.json`
 *    names under `skills`. Only direct children holding a `SKILL.md` count.
 *  - The prefix is the `name` in `.claude-plugin/plugin.json`, falling back to
 *    the id when there is no manifest. A manifest that does not parse keeps
 *    the whole plugin from loading.
 *
 * Not modelled: the CLI also refuses a plugin whose marketplace it no longer
 * knows, reads a plugin from a local directory marketplace out of that
 * directory instead of the install path, and loads plugins synced from the
 * user's Claude account, which `installed_plugins.json` does not list.
 *
 * @module provider/Drivers/ClaudePluginSkills
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

/** One folder of skill directories, and the plugin name its skills go under. */
export interface ClaudePluginSkillRoot {
  readonly directory: string;
  readonly namespace: string;
}

const decodeEnabledPluginsSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

const decodeInstalledPlugins = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Unknown) })),
);

const decodePluginInstall = Schema.decodeUnknownOption(
  Schema.Struct({
    installPath: Schema.String,
    projectPath: Schema.optional(Schema.String),
  }),
);

const decodePluginManifest = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    }),
  ),
);

function isInsideOrEqual(path: Path.Path, parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Ids switched on across the settings files, in the order they first appear.
 * `settingsPaths` runs from lowest precedence to highest.
 */
const readEnabledPluginIds = Effect.fn("readEnabledPluginIds")(function* (
  settingsPaths: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const enabledById = new Map<string, boolean>();

  for (const settingsPath of settingsPaths) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }
    const parsed = yield* decodeEnabledPluginsSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring enabledPlugins", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [id, value] of Object.entries(parsed?.enabledPlugins ?? {})) {
      if (typeof value === "boolean") {
        enabledById.set(id, value);
      }
    }
  }

  return [...enabledById].filter(([, enabled]) => enabled).map(([id]) => id);
});

/**
 * The skill folders of every plugin Claude Code would load for `cwd`, in the
 * order the plugins are switched on. Best-effort throughout: a missing or
 * malformed file drops only the plugin it describes, and never fails.
 */
export const resolveClaudePluginSkillRoots = Effect.fn("resolveClaudePluginSkillRoots")(
  function* (input: {
    readonly configDirPath: string;
    readonly cwd: string | undefined;
    /** Settings files to read `enabledPlugins` from, lowest precedence first. */
    readonly settingsPaths: ReadonlyArray<string>;
  }): Effect.fn.Return<
    ReadonlyArray<ClaudePluginSkillRoot>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const enabledIds = yield* readEnabledPluginIds(input.settingsPaths);
    if (enabledIds.length === 0) {
      return [];
    }

    const installedPath = path.join(input.configDirPath, "plugins", "installed_plugins.json");
    const installedContents = yield* fileSystem
      .readFileString(installedPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (installedContents === undefined) {
      return [];
    }
    const installed = yield* decodeInstalledPlugins(installedContents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude installed_plugins.json is unreadable; ignoring plugin skills", {
          path: installedPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (installed === undefined) {
      return [];
    }

    const roots: Array<ClaudePluginSkillRoot> = [];
    for (const id of enabledIds) {
      const installs = installed.plugins[id];
      if (!Array.isArray(installs)) {
        continue;
      }
      // The first install that applies here wins, which is what the CLI picks
      // when a plugin is installed for the user and again for this project.
      const install = installs
        .flatMap((entry) => Option.toArray(decodePluginInstall(entry)))
        .find(
          (entry) =>
            entry.projectPath === undefined ||
            (input.cwd !== undefined && isInsideOrEqual(path, entry.projectPath, input.cwd)),
        );
      if (install === undefined) {
        continue;
      }

      const manifestContents = yield* fileSystem
        .readFileString(path.join(install.installPath, ".claude-plugin", "plugin.json"))
        .pipe(Effect.orElseSucceed(() => undefined));
      const manifest =
        manifestContents === undefined
          ? {}
          : yield* decodePluginManifest(manifestContents).pipe(
              Effect.orElseSucceed(() => undefined),
            );
      if (manifest === undefined) {
        continue;
      }

      const separator = id.lastIndexOf("@");
      const namespace = (manifest.name ?? (separator > 0 ? id.slice(0, separator) : id)).trim();
      if (!namespace) {
        continue;
      }

      const extraFolders =
        manifest.skills === undefined
          ? []
          : typeof manifest.skills === "string"
            ? [manifest.skills]
            : manifest.skills;
      const directories = new Set([
        path.join(install.installPath, "skills"),
        ...extraFolders
          .map((folder) => path.resolve(install.installPath, folder))
          .filter((directory) => isInsideOrEqual(path, install.installPath, directory)),
      ]);
      for (const directory of directories) {
        roots.push({ directory, namespace });
      }
    }

    return roots;
  },
);
