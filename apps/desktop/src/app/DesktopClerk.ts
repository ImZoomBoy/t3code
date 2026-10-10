import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedError<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedError<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  const bridge = createClerkBridge({
    storage: storage({ path: stateDir }),
    passkeys: true,
    // Fork: the bridge registers this scheme as the OS link handler and uses it for
    // the OAuth return link, so it gets the fork's link scheme, not the renderer's
    // t3code. The official install keeps t3code://, and an OAuth sign-in that Clerk
    // returns to t3code://app/ does not reach the fork. Email sign-in needs no link.
    renderer: {
      scheme: ElectronProtocol.getDesktopLinkScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
  // Fork: the bridge just registered that link scheme as privileged, and Electron
  // keeps the secure, fetch and CORS schemes of the last call only. Upstream passes
  // the renderer scheme, so its window stays a secure context. Ours would not:
  // t3code://app would lose crypto.subtle, which T3 Connect needs for its relay
  // keys. List every scheme again, in the same synchronous step, before `ready`.
  ElectronProtocol.registerDesktopSchemePrivilegesSync();
  return bridge;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;

  // Electron scopes the single-instance lock to the userData directory and
  // creates that directory when the lock is acquired. The SDK bridge takes
  // the lock at creation, so userData must already point at the real
  // directory here — under the default productName-derived path, acquiring
  // the lock would create "T3 Code (Alpha)" and make the legacy-install
  // detection in resolveUserDataPath match on fresh installs.
  const userDataPath = yield* DesktopAppIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);

  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      // The SDK bridge holds Electron's single-instance lock (acquired at
      // bridge creation) so OAuth deep-link callbacks on Windows/Linux are
      // forwarded to the running app. In a secondary instance the bridge has
      // already begun quitting the app; app.quit() is asynchronous, so stop
      // bootstrap here before whenReady can fire.
      if (!bridge.isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      yield* electronApp.on("second-instance", () => {
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
            }
          }),
        );
      });
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
