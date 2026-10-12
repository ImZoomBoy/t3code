import {
  type EnvironmentCloudLinkStateResult,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const primaryTarget = {
  environmentId: "primary",
  label: "Primary",
  httpBaseUrl: "http://localhost:3773",
  wsBaseUrl: "ws://localhost:3773/ws",
};

const testState = vi.hoisted(() => ({
  signedInUserId: null as string | null,
  target: null as typeof primaryTarget | null,
  linkState: null as EnvironmentCloudLinkStateResult | null,
  linkError: null as string | null,
  getToken: vi.fn<() => Promise<string | null>>(),
  link: vi.fn(),
  unlink: vi.fn(),
  revoke: vi.fn(),
  preferences: vi.fn(),
  refreshDiscovery: vi.fn(),
  refreshLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({
    getToken: testState.getToken,
    isSignedIn: testState.signedInUserId !== null,
    userId: testState.signedInUserId,
  }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: testState.toast } }));
vi.mock("../state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: testState.refreshDiscovery },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./forkRevokeRelayLink", () => ({ revokeRelayLinkAfterLocalUnlink: testState.revoke }));
vi.mock("./linkEnvironmentAtoms", () => ({
  linkPrimaryEnvironment: testState.link,
  unlinkPrimaryEnvironment: testState.unlink,
  updatePrimaryEnvironmentPreferences: testState.preferences,
}));
vi.mock("./primaryCloudLinkState", () => ({
  usePrimaryCloudLinkState: () => ({
    target: testState.target,
    data: testState.linkState,
    error: testState.linkError,
    isPending: false,
    refresh: testState.refreshLink,
  }),
}));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));

import { useCloudLinkController } from "./useCloudLinkController";

const target = primaryTarget;

// A link is stored, but there is no managed tunnel and publishing is off, so
// both switches show OFF.
const linkedWithBothSwitchesOff: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "account-that-linked",
  relayUrl: "https://relay.example.com",
  relayIssuer: "https://relay.example.com",
  managedTunnelActive: false,
  publishAgentActivity: false,
};

// The state the report describes: a link made under another account, with the
// tunnel up and publishing on, so both switches show ON.
const linkedWithBothSwitchesOn: EnvironmentCloudLinkStateResult = {
  ...linkedWithBothSwitchesOff,
  managedTunnelActive: true,
  publishAgentActivity: true,
};

const CONFLICT_MESSAGE =
  "This environment is already linked to a different cloud account. Unlink it before switching accounts.";

// The shape linkEnvironment.ts reports: its own error wrapping the decoded
// environment server error.
function linkFailure(message: string, cause: unknown) {
  return AsyncResult.failure(Cause.fail(new Error(message, { cause })));
}

const decodeConflict = Schema.decodeUnknownSync(EnvironmentHttpConflictError);

// Decoded from the 409 body as it arrives on the wire.
const conflict = (reason?: string) =>
  linkFailure(
    `Could not configure environment relay access: ${CONFLICT_MESSAGE}`,
    decodeConflict({
      _tag: "EnvironmentHttpConflictError",
      message: CONFLICT_MESSAGE,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
const accountConflict = () => conflict("linked_to_different_cloud_account");

const unlinkedToast = expect.objectContaining({ type: "success", title: "This PC is unlinked" });
const otherAccountWarning = expect.objectContaining({
  type: "warning",
  title: "Another account still lists this PC",
});
const signedOutWarning = expect.objectContaining({
  type: "warning",
  title: "T3 Connect still lists this PC",
  description: expect.stringContaining("You are signed out of T3 Connect"),
});
const ownAccountWarning = expect.objectContaining({
  type: "warning",
  title: "T3 Connect may still list this PC",
});
const anyWarning = expect.objectContaining({ type: "warning" });

let renderer: ReactTestRenderer | null = null;
let controller: ReturnType<typeof useCloudLinkController> | null = null;

function ControllerProbe() {
  const value = useCloudLinkController();
  useLayoutEffect(() => {
    controller = value;
  });
  return null;
}

async function mountController() {
  await act(() => {
    renderer = create(<ControllerProbe />);
  });
  if (controller === null) throw new Error("Controller is not mounted.");
  return controller;
}

// Renders again after the account, the environment or the link state changed.
async function rerender() {
  await act(() => renderer?.update(<ControllerProbe />));
}

function mounted() {
  if (controller === null) throw new Error("Controller is not mounted.");
  return controller;
}

// Runs a request, then lets the task that adds the unlink toasts run.
async function request(run: () => Promise<boolean>) {
  let ok = false;
  await act(async () => {
    ok = await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return ok;
}

const unlinkThisPc = () => request(() => mounted().unlinkThisPc());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  testState.signedInUserId = "account-signed-in";
  testState.target = primaryTarget;
  testState.linkState = linkedWithBothSwitchesOff;
  testState.linkError = null;
  testState.getToken.mockReset().mockResolvedValue("clerk-token");
  for (const command of [
    testState.link,
    testState.unlink,
    testState.revoke,
    testState.preferences,
    testState.refreshDiscovery,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success({}));
  }
  testState.refreshLink.mockReset();
  testState.toast.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  controller = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unlink this PC", () => {
  it("unlinks a PC linked under another account with both switches off", async () => {
    const stuck = await mountController();
    expect(stuck.linked).toBe(true);
    expect(stuck.managedTunnelActive).toBe(false);
    expect(stuck.publishAgentActivity).toBe(false);
    expect(stuck.linkedAccountDiffers).toBe(true);

    expect(await unlinkThisPc()).toBe(true);

    // The local unlink carries no token. The revoke follows with the signed-in
    // account's token, so the relay can drop the entry that account's refused
    // link attempts left behind.
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.revoke).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
    });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalled();
    expect(testState.toast).toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).toHaveBeenCalledWith(otherAccountWarning);
  });

  it("unlinks when the relay token read never settles", async () => {
    testState.getToken.mockReturnValue(new Promise(() => undefined));
    await mountController();

    expect(await unlinkThisPc()).toBe(true);

    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.revoke).not.toHaveBeenCalled();
    expect(testState.toast).toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).toHaveBeenCalledWith(otherAccountWarning);
  });

  it("unlinks while signed out and does not call the linking account another account", async () => {
    testState.signedInUserId = null;
    const signedOut = await mountController();
    expect(signedOut.linkedAccountDiffers).toBe(false);

    expect(await unlinkThisPc()).toBe(true);

    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.getToken).not.toHaveBeenCalled();
    expect(testState.revoke).not.toHaveBeenCalled();
    expect(testState.refreshDiscovery).not.toHaveBeenCalled();
    expect(testState.toast).toHaveBeenCalledWith(signedOutWarning);
    expect(testState.toast).not.toHaveBeenCalledWith(otherAccountWarning);
  });

  it("revokes at the relay without a warning when the signed-in account made the link", async () => {
    testState.signedInUserId = "account-that-linked";
    const sameAccount = await mountController();
    expect(sameAccount.linkedAccountDiffers).toBe(false);

    expect(await unlinkThisPc()).toBe(true);

    expect(testState.revoke).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
    });
    expect(testState.toast).toHaveBeenCalledExactlyOnceWith(unlinkedToast);
  });

  it("says the user's own account may still list this PC when the revoke fails", async () => {
    testState.signedInUserId = "account-that-linked";
    testState.revoke.mockResolvedValue(linkFailure("unlink relay environment failed", null));
    await mountController();

    expect(await unlinkThisPc()).toBe(true);

    expect(testState.toast).toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).toHaveBeenCalledWith(ownAccountWarning);
  });

  it("says the user's own account may still list this PC when the relay token cannot be read", async () => {
    testState.signedInUserId = "account-that-linked";
    testState.getToken.mockRejectedValue(new Error("token read failed"));
    await mountController();

    expect(await unlinkThisPc()).toBe(true);

    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.revoke).not.toHaveBeenCalled();
    expect(testState.toast).toHaveBeenCalledWith(ownAccountWarning);
  });

  it("reports a failed unlink and leaves the link in place", async () => {
    testState.unlink.mockResolvedValue(
      linkFailure("Could not unlink the environment from cloud.", null),
    );
    await mountController();

    expect(await unlinkThisPc()).toBe(false);

    expect(mounted().operationError).toBe("Could not unlink the environment from cloud.");
    expect(testState.refreshLink).toHaveBeenCalled();
    expect(testState.revoke).not.toHaveBeenCalled();
    expect(testState.toast).not.toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).not.toHaveBeenCalledWith(anyWarning);
  });

  it("offers the unlink when the link state cannot be read, without claiming a link", async () => {
    testState.linkState = null;
    testState.linkError = "Could not read environment cloud link state.";
    const unreadable = await mountController();
    expect(unreadable.linked).toBe(false);
    expect(unreadable.unlinkOffer).toBe("unknown");

    expect(await unlinkThisPc()).toBe(true);

    expect(testState.unlink).toHaveBeenCalledOnce();
    expect(testState.toast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: "No T3 Connect link is stored on this PC",
      description: "If this PC held a link, it was removed.",
    });
  });

  it("offers no unlink when the link state loaded and holds no link", async () => {
    testState.linkState = { ...linkedWithBothSwitchesOff, linked: false, cloudUserId: null };

    expect((await mountController()).unlinkOffer).toBe("none");
  });
});

describe("different-account conflict", () => {
  const switchTunnelOn = () =>
    act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: true, publish: false });
    });

  it("points at the unlink control by its typed reason", async () => {
    // Reworded on purpose: the hint must not depend on the server's prose.
    testState.link.mockResolvedValue(
      linkFailure(
        "Could not configure environment relay access: Linked elsewhere.",
        new EnvironmentHttpConflictError({
          message: "Linked elsewhere.",
          reason: "linked_to_different_cloud_account",
        }),
      ),
    );
    await mountController();

    await switchTunnelOn();

    expect(testState.link).toHaveBeenCalledOnce();
    expect(mounted().operationError).toContain('Use "Unlink this PC" in Settings > Connections');
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: expect.stringContaining('Use "Unlink this PC" in Settings > Connections'),
      }),
    );
  });

  it("shows an older server's conflict as the server worded it", async () => {
    // A server that predates the typed reason sends the message alone.
    testState.link.mockResolvedValue(conflict());
    await mountController();

    await switchTunnelOn();

    expect(mounted().operationError).toBe(
      `Could not configure environment relay access: ${CONFLICT_MESSAGE}`,
    );
  });

  it("shows a newer server's unknown reason as the server worded it", async () => {
    testState.link.mockResolvedValue(conflict("a_reason_added_later"));
    await mountController();

    await switchTunnelOn();

    expect(mounted().operationError).toBe(
      `Could not configure environment relay access: ${CONFLICT_MESSAGE}`,
    );
  });

  it("clears once the PC is unlinked", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();
    await switchTunnelOn();
    expect(mounted().operationError).not.toBeNull();

    await unlinkThisPc();

    expect(mounted().operationError).toBeNull();
  });

  it("leaves other link failures worded as they were", async () => {
    testState.link.mockResolvedValue(linkFailure("Could not obtain environment link proof.", null));
    await mountController();

    await switchTunnelOn();

    expect(mounted().operationError).toBe("Could not obtain environment link proof.");
  });
});

// The reported path: the PC is linked under another account and both switches
// show ON. Switching T3 Connect off first needs a relink, which is refused, so
// that switch stays ON. Switching publishing off next must still unlink.
describe("the Settings switches", () => {
  beforeEach(() => {
    testState.linkState = linkedWithBothSwitchesOn;
  });

  // What ConnectionsSettings requests: the switch that moved, plus what the
  // server holds for the other one.
  const switchTunnelOff = () =>
    request(() => mounted().reconcileSettingsSwitches({ managedTunnel: false, publish: true }));
  const switchPublishingOff = () =>
    request(() => mounted().reconcileSettingsSwitches({ managedTunnel: true, publish: false }));
  const switchLastOff = () =>
    request(() => mounted().reconcileSettingsSwitches({ managedTunnel: false, publish: false }));
  const expectLinkKept = () => {
    expect(testState.unlink).not.toHaveBeenCalled();
    expect(testState.preferences).toHaveBeenCalledExactlyOnceWith({
      target,
      publishAgentActivity: false,
    });
  };

  it("unlink when this PC refused the T3 Connect switch-off for another account", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    expect(await switchTunnelOff()).toBe(false);
    expect(mounted().operationError).toContain('Use "Unlink this PC"');
    expect(testState.unlink).not.toHaveBeenCalled();

    expect(await switchPublishingOff()).toBe(true);

    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(mounted().operationError).toBeNull();
    expect(testState.toast).toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).toHaveBeenCalledWith(otherAccountWarning);
  });

  it("still say so when the relay list cannot be refreshed after that unlink", async () => {
    testState.link.mockResolvedValue(accountConflict());
    testState.refreshDiscovery.mockResolvedValue(linkFailure("relay list failed", null));
    await mountController();

    await switchTunnelOff();
    expect(await switchPublishingOff()).toBe(true);

    expect(testState.toast).toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).toHaveBeenCalledWith(otherAccountWarning);
  });

  it("keep the link when the T3 Connect switch-off failed for a network error", async () => {
    testState.link.mockResolvedValue(
      linkFailure("https://relay.example.com/v1/client/environment-links failed", null),
    );
    await mountController();

    expect(await switchTunnelOff()).toBe(false);
    await switchPublishingOff();

    expectLinkKept();
  });

  it("keep the link when the T3 Connect switch-off failed for a conflict without the typed reason", async () => {
    testState.link.mockResolvedValue(conflict());
    await mountController();

    await switchTunnelOff();
    await switchPublishingOff();

    expectLinkKept();
  });

  it("keep the link when the T3 Connect switch-off failed on the relay token", async () => {
    testState.getToken.mockRejectedValueOnce(new Error("token read failed"));
    await mountController();

    expect(await switchTunnelOff()).toBe(false);
    await switchPublishingOff();

    expectLinkKept();
  });

  it("keep the link when the T3 Connect switch-off failed for a signed-out session", async () => {
    testState.getToken.mockResolvedValueOnce(null);
    await mountController();

    expect(await switchTunnelOff()).toBe(false);
    await switchPublishingOff();

    expectLinkKept();
  });

  it("forget a refused switch-off when the signed-in account changes", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    await switchTunnelOff();
    testState.signedInUserId = "a-third-account";
    await rerender();
    await switchPublishingOff();

    expectLinkKept();
  });

  it("forget a refused switch-off when the environment changes", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    await switchTunnelOff();
    testState.target = { ...primaryTarget, environmentId: "another-environment" };
    await rerender();
    await switchPublishingOff();

    expect(testState.unlink).not.toHaveBeenCalled();
    expect(testState.preferences).toHaveBeenCalledOnce();
  });

  it("forget a refused switch-off when the link state changes", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    await switchTunnelOff();
    testState.linkState = { ...linkedWithBothSwitchesOn, cloudUserId: "relinked-elsewhere" };
    await rerender();
    await switchPublishingOff();

    expectLinkKept();
  });

  it("forget a refused switch-off once another request goes through", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    await switchTunnelOff();
    await act(async () => {
      await mounted().reconcileSettingsSwitches({ managedTunnel: true, publish: true });
    });
    testState.preferences.mockClear();
    await switchPublishingOff();

    expectLinkKept();
  });

  it("keep the link when publishing goes off without a refused switch-off", async () => {
    await mountController();

    await switchPublishingOff();

    expectLinkKept();
  });

  it("never carry a refused switch-off into onboarding", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    await switchTunnelOff();
    // ConnectOnboardingDialog applies its selection through reconcileCloudState.
    await act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: true, publish: false });
    });

    expectLinkKept();
  });

  it("unlink and warn about the other account when the last switch goes off", async () => {
    testState.linkState = { ...linkedWithBothSwitchesOn, publishAgentActivity: false };
    await mountController();

    expect(await switchLastOff()).toBe(true);

    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.revoke).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
    });
    // The switch adds its own success toast, so only the warning comes from here.
    expect(testState.toast).toHaveBeenCalledExactlyOnceWith(otherAccountWarning);
  });

  it("unlink when the last switch goes off and the relay token read never settles", async () => {
    testState.signedInUserId = "account-that-linked";
    testState.linkState = { ...linkedWithBothSwitchesOn, publishAgentActivity: false };
    testState.getToken.mockReturnValue(new Promise(() => undefined));
    await mountController();

    expect(await switchLastOff()).toBe(true);

    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.toast).not.toHaveBeenCalled();
  });
});
