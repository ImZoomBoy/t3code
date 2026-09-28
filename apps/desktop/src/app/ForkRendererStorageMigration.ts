import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

/**
 * Fork-only: the fork used to serve its renderer from t3code-fork://app. It now
 * uses upstream's t3code://app, the only origin T3's Clerk instance accepts for
 * T3 Connect. Browser storage belongs to an origin, so composer drafts, the prompt
 * stash, custom themes and sidebar folds stayed behind at the old one. This copies
 * the old origin's localStorage into the new one once, before the main window
 * loads, and never overwrites a key the new origin already holds.
 */

export type StorageEntries = ReadonlyArray<readonly [string, string]>;

/** Written to the userData directory once the copy has run. */
export const MIGRATION_MARKER_FILE = "fork-renderer-storage-migrated";

const MIGRATION_TIMEOUT = Duration.seconds(20);
const BLANK_PAGE = "<!doctype html><title></title>";
const READ_LOCAL_STORAGE = "Object.entries(window.localStorage)";

const StorageEntriesSchema = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const decodeStorageEntries = Schema.decodeUnknownEffect(StorageEntriesSchema);
const encodeStorageEntriesJson = Schema.encodeEffect(Schema.fromJsonString(StorageEntriesSchema));

export class ForkRendererStorageMigrationError extends Schema.TaggedError<ForkRendererStorageMigrationError>()(
  "ForkRendererStorageMigrationError",
  {
    step: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Copying browser storage from the old renderer origin failed at: ${this.step}.`;
  }
}

/** The legacy entries to write: every key the current origin does not hold yet. */
export function planLegacyStorageCopy(
  legacy: StorageEntries,
  current: StorageEntries,
): Array<readonly [string, string]> {
  const present = new Set(current.map(([key]) => key));
  return legacy.filter(([key]) => !present.has(key));
}

export type ForkRendererStorageMigrationResult =
  | { readonly _tag: "AlreadyMigrated" }
  | { readonly _tag: "Copied"; readonly copied: number; readonly kept: number };

const serveBlankPage = () =>
  new Response(BLANK_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * Runs the copy once per userData directory. Call it after `ready` and before the
 * renderer scheme gets its real handler: both schemes are served a blank page
 * while it runs, so neither origin boots the app. It loads the pages in a
 * WebContentsView rather than a window, because closing the last window quits
 * the app on Windows and Linux.
 */
export const migrateLegacyRendererStorage = Effect.fn("desktop.fork.migrateRendererStorage")(
  function* (input: {
    readonly legacyScheme: string;
    readonly currentScheme: string;
    readonly host: string;
    readonly userDataPath: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(input.userDataPath, MIGRATION_MARKER_FILE);
    if (yield* fileSystem.exists(markerPath).pipe(Effect.orElseSucceed(() => false))) {
      return { _tag: "AlreadyMigrated" } satisfies ForkRendererStorageMigrationResult;
    }

    const attempt = (step: string) => (cause: unknown) =>
      new ForkRendererStorageMigrationError({ step, cause });

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        for (const scheme of [input.legacyScheme, input.currentScheme]) {
          yield* Effect.acquireRelease(
            Effect.try({
              try: () => Electron.protocol.handle(scheme, serveBlankPage),
              catch: attempt(`serve ${scheme}`),
            }),
            () => Effect.sync(() => Electron.protocol.unhandle(scheme)),
          );
        }
        const view = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              new Electron.WebContentsView({
                webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
              }),
            catch: attempt("create view"),
          }),
          (view) => Effect.sync(() => view.webContents.close()),
        );
        const readAt = (scheme: string) =>
          Effect.tryPromise({
            try: async () => {
              await view.webContents.loadURL(`${scheme}://${input.host}/`);
              return (await view.webContents.executeJavaScript(READ_LOCAL_STORAGE)) as unknown;
            },
            catch: attempt(`read ${scheme}`),
          }).pipe(
            Effect.flatMap((raw) =>
              decodeStorageEntries(raw).pipe(Effect.mapError(attempt(`decode ${scheme}`))),
            ),
          );

        const legacy = yield* readAt(input.legacyScheme);
        const current = yield* readAt(input.currentScheme);
        const toCopy = planLegacyStorageCopy(legacy, current);
        if (toCopy.length > 0) {
          // JSON is a valid JavaScript expression, so the entries go in as a literal.
          const literal = yield* encodeStorageEntriesJson(toCopy).pipe(
            Effect.mapError(attempt(`encode ${input.currentScheme}`)),
          );
          yield* Effect.tryPromise({
            try: () =>
              view.webContents.executeJavaScript(
                `for (const [key, value] of ${literal}) window.localStorage.setItem(key, value);`,
              ),
            catch: attempt(`write ${input.currentScheme}`),
          });
          // Chromium commits localStorage to disk later. Commit now, so a crash right
          // after this cannot lose the copy once the marker says it is done.
          yield* Effect.try({
            try: () => view.webContents.session.flushStorageData(),
            catch: attempt("flush storage"),
          });
        }
        return {
          _tag: "Copied",
          copied: toCopy.length,
          kept: legacy.length - toCopy.length,
        } satisfies ForkRendererStorageMigrationResult;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: MIGRATION_TIMEOUT,
        orElse: () =>
          Effect.fail(new ForkRendererStorageMigrationError({ step: "timeout", cause: null })),
      }),
    );

    yield* fileSystem
      .writeFileString(markerPath, "copied\n")
      .pipe(Effect.mapError(attempt("write marker")));
    return result;
  },
);
