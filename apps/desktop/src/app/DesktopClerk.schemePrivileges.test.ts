import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

// Fork: runs the real @clerk/electron bridge against a stand-in for Electron's
// scheme registry, in the order main.ts starts them. The bridge registers its own
// scheme list, and the stand-in keeps what Electron 44 was seen to keep: the
// standard and stream schemes of every call, and the secure, fetch and CORS schemes
// of the last call only.
const { electron, registry } = vi.hoisted(() => {
  const registry = {
    standard: new Set<string>(),
    secure: [] as string[],
    fetch: [] as string[],
    cors: [] as string[],
    stream: new Set<string>(),
  };
  type CustomScheme = {
    readonly scheme: string;
    readonly privileges?: {
      readonly standard?: boolean;
      readonly secure?: boolean;
      readonly supportFetchAPI?: boolean;
      readonly corsEnabled?: boolean;
      readonly stream?: boolean;
    };
  };
  const withPrivilege = (
    schemes: ReadonlyArray<CustomScheme>,
    privilege: keyof NonNullable<CustomScheme["privileges"]>,
  ) => schemes.filter((entry) => entry.privileges?.[privilege]).map((entry) => entry.scheme);
  const electron = {
    app: {
      hasSingleInstanceLock: () => false,
      requestSingleInstanceLock: () => true,
      releaseSingleInstanceLock: () => undefined,
      setAsDefaultProtocolClient: vi.fn(),
      on: () => undefined,
      removeListener: () => undefined,
      quit: () => undefined,
    },
    ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    protocol: {
      registerSchemesAsPrivileged: (schemes: ReadonlyArray<CustomScheme>) => {
        for (const scheme of withPrivilege(schemes, "standard")) registry.standard.add(scheme);
        registry.secure = withPrivilege(schemes, "secure");
        registry.fetch = withPrivilege(schemes, "supportFetchAPI");
        registry.cors = withPrivilege(schemes, "corsEnabled");
        for (const scheme of withPrivilege(schemes, "stream")) registry.stream.add(scheme);
      },
    },
    net: {},
    shell: {},
    BrowserWindow: {},
  };
  return { electron, registry };
});

vi.mock("electron", () => ({ ...electron, default: electron }));
vi.mock("@clerk/electron/storage", () => ({
  storage: () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }),
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeStartupLayer = (isDevelopment: boolean) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: isDevelopment ? "t3code-fork-dev" : "t3code-fork",
    legacyUserDataDirName: isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const electronApp = {
    setPath: () => Effect.void,
  } as unknown as ElectronApp.ElectronApp["Service"];

  // main.ts acquires the pre-ready scheme privileges first, then the Clerk bridge.
  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
    Layer.provideMerge(ElectronProtocol.layerSchemePrivileges),
  );
};

describe("DesktopClerk scheme privileges", () => {
  beforeEach(() => {
    registry.standard.clear();
    registry.secure = [];
    registry.fetch = [];
    registry.cors = [];
    registry.stream.clear();
    electron.app.setAsDefaultProtocolClient.mockClear();
  });

  for (const { isDevelopment, rendererScheme, linkScheme } of [
    { isDevelopment: false, rendererScheme: "t3code", linkScheme: "t3code-fork" },
    { isDevelopment: true, rendererScheme: "t3code-dev", linkScheme: "t3code-fork-dev" },
  ]) {
    it.effect(`keeps ${rendererScheme}://app a secure context once the bridge exists`, () =>
      Effect.gen(function* () {
        yield* Layer.build(makeStartupLayer(isDevelopment));

        assert.equal(ElectronProtocol.getDesktopScheme(isDevelopment), rendererScheme);
        // Without `secure` the window is not a secure context: crypto.subtle is
        // undefined there, and T3 Connect cannot make its relay keys.
        for (const privilege of ["secure", "fetch", "cors"] as const) {
          assert.include(registry[privilege], rendererScheme, privilege);
          // The old origin is still loaded once, by the storage migration.
          assert.include(registry[privilege], linkScheme, privilege);
        }
        assert.isTrue(registry.standard.has(rendererScheme));
        assert.isTrue(registry.stream.has(rendererScheme));
        // The bridge still claims only the fork's link scheme from the OS.
        assert.deepEqual(electron.app.setAsDefaultProtocolClient.mock.calls, [[linkScheme]]);
      }).pipe(Effect.scoped),
    );
  }
});
