import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { beforeEach, vi } from "vite-plus/test";

// Each origin gets its own localStorage, as in Chromium. The view reads whichever
// origin it last loaded, and runs the module's write script against that store.
const { origins, handleMock, unhandleMock, closeMock, flushMock, state } = vi.hoisted(() => {
  const origins = new Map<string, Map<string, string>>();
  return {
    origins,
    handleMock: vi.fn(),
    unhandleMock: vi.fn(),
    closeMock: vi.fn(),
    flushMock: vi.fn(),
    state: { loaded: "", corruptOrigin: "" },
  };
});

vi.mock("electron", () => {
  const storeFor = (origin: string) => {
    let store = origins.get(origin);
    if (!store) {
      store = new Map();
      origins.set(origin, store);
    }
    return store;
  };
  class WebContentsView {
    webContents = {
      loadURL: async (url: string) => {
        state.loaded = url;
      },
      executeJavaScript: async (code: string) => {
        const { protocol, host } = new URL(state.loaded);
        const origin = `${protocol}//${host}`;
        const store = storeFor(origin);
        if (code === "Object.entries(window.localStorage)") {
          return origin === state.corruptOrigin ? [["key", 1]] : [...store.entries()];
        }
        const localStorage = { setItem: (key: string, value: string) => store.set(key, value) };
        new Function("window", code)({ localStorage });
        return undefined;
      },
      close: closeMock,
      session: { flushStorageData: flushMock },
    };
  }
  return { protocol: { handle: handleMock, unhandle: unhandleMock }, WebContentsView };
});

import {
  MIGRATION_MARKER_FILE,
  migrateLegacyRendererStorage,
  planLegacyStorageCopy,
} from "./ForkRendererStorageMigration.ts";
import {
  DESKTOP_HOST,
  getDesktopLinkScheme,
  getDesktopScheme,
} from "../electron/ElectronProtocol.ts";

const LEGACY_SCHEME = getDesktopLinkScheme(false);
const CURRENT_SCHEME = getDesktopScheme(false);
const LEGACY = `${LEGACY_SCHEME}://${DESKTOP_HOST}`;
const CURRENT = `${CURRENT_SCHEME}://${DESKTOP_HOST}`;

const migrate = (userDataPath: string) =>
  migrateLegacyRendererStorage({
    legacyScheme: LEGACY_SCHEME,
    currentScheme: CURRENT_SCHEME,
    host: DESKTOP_HOST,
    userDataPath,
  });

describe("planLegacyStorageCopy", () => {
  it("copies only the keys the new origin does not hold", () => {
    assert.deepStrictEqual(
      planLegacyStorageCopy(
        [
          ["t3code:composer-drafts:v1", "old draft"],
          ["t3code:theme", "dark"],
        ],
        [["t3code:theme", "light"]],
      ),
      [["t3code:composer-drafts:v1", "old draft"]],
    );
  });
});

describe("migrateLegacyRendererStorage", () => {
  beforeEach(() => {
    origins.clear();
    handleMock.mockReset();
    unhandleMock.mockReset();
    closeMock.mockReset();
    flushMock.mockReset();
    state.loaded = "";
    state.corruptOrigin = "";
  });

  it.effect("moves drafts, stash, themes and folds to the new origin once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const userData = yield* fileSystem.makeTempDirectoryScoped();
      origins.set(
        LEGACY,
        new Map([
          ["t3code:composer-drafts:v1", '{"thread-1":"half-written prompt"}'],
          ["t3code:prompt-stash:v2", '["stashed"]'],
          ["t3code:themes:v1", '[{"id":"mine"}]'],
          ["t3code:ui-state:v1", '{"fleetRepoExpandedById":{"t3code":false}}'],
          ["t3code:sidebar:settled-expanded", "true"],
          ["t3code:theme", "dark"],
        ]),
      );
      origins.set(CURRENT, new Map([["t3code:theme", "light"]]));

      const first = yield* migrate(userData);
      assert.deepStrictEqual(first, { _tag: "Copied", copied: 5, skipped: 1 });
      const current = origins.get(CURRENT)!;
      assert.equal(current.get("t3code:composer-drafts:v1"), '{"thread-1":"half-written prompt"}');
      assert.equal(current.get("t3code:prompt-stash:v2"), '["stashed"]');
      assert.equal(current.get("t3code:themes:v1"), '[{"id":"mine"}]');
      assert.equal(current.get("t3code:ui-state:v1"), '{"fleetRepoExpandedById":{"t3code":false}}');
      // A value the new origin already holds wins over the old one.
      assert.equal(current.get("t3code:theme"), "light");
      assert.isTrue(yield* fileSystem.exists(`${userData}/${MIGRATION_MARKER_FILE}`));
      // The blank pages are gone again, so the real renderer handler can register.
      assert.deepStrictEqual(
        unhandleMock.mock.calls.map(([scheme]) => scheme).toSorted(),
        [CURRENT_SCHEME, LEGACY_SCHEME].toSorted(),
      );
      assert.equal(closeMock.mock.calls.length, 1);
      // The copy is committed to disk before the marker is written.
      assert.equal(flushMock.mock.calls.length, 1);

      // A later edit at the new origin survives the next launch.
      current.set("t3code:composer-drafts:v1", "newer draft");
      const second = yield* migrate(userData);
      assert.deepStrictEqual(second, { _tag: "AlreadyMigrated" });
      assert.equal(current.get("t3code:composer-drafts:v1"), "newer draft");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops retrying a failing copy after three launches", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const userData = yield* fileSystem.makeTempDirectoryScoped();
      const markerPath = `${userData}/${MIGRATION_MARKER_FILE}`;
      state.corruptOrigin = LEGACY;

      for (const launch of [1, 2, 3]) {
        const exit = yield* Effect.exit(migrate(userData));
        assert.isTrue(Exit.isFailure(exit));
        assert.equal((yield* fileSystem.readFileString(markerPath)).trim(), `failed ${launch}`);
      }
      const pagesLoadedBefore = handleMock.mock.calls.length;

      // The fourth launch skips the copy and opens the window without waiting on it.
      assert.deepStrictEqual(yield* migrate(userData), { _tag: "GaveUp", attempts: 3 });
      assert.equal(handleMock.mock.calls.length, pagesLoadedBefore);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a retry after a failed launch still never overwrites the new origin", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const userData = yield* fileSystem.makeTempDirectoryScoped();
      origins.set(
        LEGACY,
        new Map([
          ["t3code:composer-drafts:v1", "old draft"],
          ["t3code:theme", "dark"],
        ]),
      );
      origins.set(CURRENT, new Map([["t3code:theme", "light"]]));
      state.corruptOrigin = LEGACY;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(migrate(userData))));

      state.corruptOrigin = "";
      assert.deepStrictEqual(yield* migrate(userData), {
        _tag: "Copied",
        copied: 1,
        skipped: 1,
      });
      const current = origins.get(CURRENT)!;
      assert.equal(current.get("t3code:composer-drafts:v1"), "old draft");
      assert.equal(current.get("t3code:theme"), "light");
      assert.equal(
        (yield* fileSystem.readFileString(`${userData}/${MIGRATION_MARKER_FILE}`)).trim(),
        "copied",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
