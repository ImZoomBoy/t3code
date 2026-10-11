import {
  type EnvironmentCloudLinkStateResult,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  signedInUserId: null as string | null,
  linkState: null as EnvironmentCloudLinkStateResult | null,
  linkError: null as string | null,
  getToken: vi.fn<() => Promise<string | null>>(),
  link: vi.fn(),
  unlink: vi.fn(),
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
vi.mock("./linkEnvironmentAtoms", () => ({
  linkPrimaryEnvironment: testState.link,
  unlinkPrimaryEnvironment: testState.unlink,
  updatePrimaryEnvironmentPreferences: testState.preferences,
}));
vi.mock("./primaryCloudLinkState", () => ({
  usePrimaryCloudLinkState: () => ({
    target,
    data: testState.linkState,
    error: testState.linkError,
    isPending: false,
    refresh: testState.refreshLink,
  }),
}));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));

import { useCloudLinkController } from "./useCloudLinkController";

const target = {
  environmentId: "primary",
  label: "Primary",
  httpBaseUrl: "http://localhost:3773",
  wsBaseUrl: "ws://localhost:3773/ws",
};

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

const accountConflict = () =>
  linkFailure(
    `Could not configure environment relay access: ${CONFLICT_MESSAGE}`,
    new EnvironmentHttpConflictError({
      message: CONFLICT_MESSAGE,
      reason: "linked_to_different_cloud_account",
    }),
  );

const unlinkedToast = expect.objectContaining({ type: "success", title: "This PC is unlinked" });
const stillListedWarning = expect.objectContaining({
  type: "warning",
  description: expect.stringContaining("sign in as that account and choose Deregister"),
});

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

function mounted() {
  if (controller === null) throw new Error("Controller is not mounted.");
  return controller;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  testState.signedInUserId = "account-signed-in";
  testState.linkState = linkedWithBothSwitchesOff;
  testState.linkError = null;
  testState.getToken.mockReset().mockResolvedValue("clerk-token");
  for (const command of [
    testState.link,
    testState.unlink,
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

    let unlinked = false;
    await act(async () => {
      unlinked = await mounted().unlinkThisPc();
    });

    expect(unlinked).toBe(true);
    // The signed-in account's token goes along, so the relay can drop the entry
    // that account's refused link attempts left behind.
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
    });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalled();
    expect(testState.toast).toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).toHaveBeenCalledWith(stillListedWarning);
  });

  it("unlinks a PC linked under another account when the relay token cannot be read", async () => {
    testState.getToken.mockRejectedValue(new Error("token read failed"));
    await mountController();

    let unlinked = false;
    await act(async () => {
      unlinked = await mounted().unlinkThisPc();
    });

    expect(unlinked).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.toast).toHaveBeenCalledWith(stillListedWarning);
  });

  it("unlinks while signed out of T3 Connect", async () => {
    testState.signedInUserId = null;
    const signedOut = await mountController();
    expect(signedOut.linkedAccountDiffers).toBe(false);

    let unlinked = false;
    await act(async () => {
      unlinked = await mounted().unlinkThisPc();
    });

    expect(unlinked).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.getToken).not.toHaveBeenCalled();
    expect(testState.refreshDiscovery).not.toHaveBeenCalled();
    // Nothing was revoked at the relay, so the linking account keeps its entry.
    expect(testState.toast).toHaveBeenCalledWith(stillListedWarning);
  });

  it("also revokes at the relay when the signed-in account made the link", async () => {
    testState.signedInUserId = "account-that-linked";
    const sameAccount = await mountController();
    expect(sameAccount.linkedAccountDiffers).toBe(false);

    await act(async () => {
      await mounted().unlinkThisPc();
    });

    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
    });
    expect(testState.toast).toHaveBeenCalledExactlyOnceWith(unlinkedToast);
  });

  it("still unlinks locally when the relay token cannot be read", async () => {
    testState.signedInUserId = "account-that-linked";
    testState.getToken.mockRejectedValue(new Error("token read failed"));
    await mountController();

    let unlinked = false;
    await act(async () => {
      unlinked = await mounted().unlinkThisPc();
    });

    expect(unlinked).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
  });

  it("reports a failed unlink and leaves the link in place", async () => {
    testState.unlink.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Could not unlink the environment from cloud."))),
    );
    await mountController();

    let unlinked = true;
    await act(async () => {
      unlinked = await mounted().unlinkThisPc();
    });

    expect(unlinked).toBe(false);
    expect(mounted().operationError).toBe("Could not unlink the environment from cloud.");
    expect(testState.refreshLink).toHaveBeenCalled();
    expect(testState.toast).not.toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).not.toHaveBeenCalledWith(stillListedWarning);
  });

  it("offers the unlink when the link state cannot be read, without claiming a link", async () => {
    testState.linkState = null;
    testState.linkError = "Could not read environment cloud link state.";
    const unreadable = await mountController();
    expect(unreadable.linked).toBe(false);
    expect(unreadable.unlinkOffer).toBe("unknown");

    let unlinked = false;
    await act(async () => {
      unlinked = await mounted().unlinkThisPc();
    });

    expect(unlinked).toBe(true);
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

  it("points the different-account conflict at the unlink control by its typed reason", async () => {
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

    let linked = true;
    await act(async () => {
      linked = await mounted().reconcileCloudState({ managedTunnel: true, publish: false });
    });

    expect(linked).toBe(false);
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
    testState.link.mockResolvedValue(
      linkFailure(
        `Could not configure environment relay access: ${CONFLICT_MESSAGE}`,
        new EnvironmentHttpConflictError({ message: CONFLICT_MESSAGE }),
      ),
    );
    await mountController();

    await act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: true, publish: false });
    });

    expect(mounted().operationError).toBe(
      `Could not configure environment relay access: ${CONFLICT_MESSAGE}`,
    );
  });

  it("clears a shown conflict once the PC is unlinked", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();
    await act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: true, publish: false });
    });
    expect(mounted().operationError).not.toBeNull();

    await act(async () => {
      await mounted().unlinkThisPc();
    });

    expect(mounted().operationError).toBeNull();
  });

  it("leaves other link failures worded as they were", async () => {
    testState.link.mockResolvedValue(linkFailure("Could not obtain environment link proof.", null));
    await mountController();

    await act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: true, publish: false });
    });

    expect(mounted().operationError).toBe("Could not obtain environment link proof.");
  });
});

// The reported path: the PC is linked under another account and both switches
// show ON. Switching T3 Connect off first needs a relink, which is refused, so
// that switch stays ON. Switching publishing off next must still unlink.
describe("switching both switches off", () => {
  beforeEach(() => {
    testState.linkState = linkedWithBothSwitchesOn;
  });

  // What ConnectionsSettings requests: the switch that moved, plus what the
  // server holds for the other one.
  const switchTunnelOff = () =>
    mounted().reconcileCloudState({ managedTunnel: false, publish: true });
  const switchPublishingOff = () =>
    mounted().reconcileCloudState({ managedTunnel: true, publish: false });

  it("unlinks when this PC refused the tunnel switch-off for another account", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    let tunnelOff = true;
    await act(async () => {
      tunnelOff = await switchTunnelOff();
    });
    expect(tunnelOff).toBe(false);
    expect(mounted().operationError).toContain('Use "Unlink this PC"');
    expect(testState.unlink).not.toHaveBeenCalled();

    let publishingOff = false;
    await act(async () => {
      publishingOff = await switchPublishingOff();
    });

    expect(publishingOff).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
    });
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(mounted().operationError).toBeNull();
    expect(testState.toast).toHaveBeenCalledWith(unlinkedToast);
    expect(testState.toast).toHaveBeenCalledWith(stillListedWarning);
  });

  it("unlinks when the relay refused the tunnel switch-off", async () => {
    testState.signedInUserId = "account-that-linked";
    testState.link.mockResolvedValue(
      linkFailure("https://relay.example.com/v1/client/environment-links failed", null),
    );
    await mountController();

    await act(async () => {
      await switchTunnelOff();
    });
    let publishingOff = false;
    await act(async () => {
      publishingOff = await switchPublishingOff();
    });

    expect(publishingOff).toBe(true);
    expect(testState.unlink).toHaveBeenCalledOnce();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.toast).not.toHaveBeenCalledWith(stillListedWarning);
  });

  it("keeps the link when publishing goes off without a refused tunnel switch-off", async () => {
    await mountController();

    await act(async () => {
      await switchPublishingOff();
    });

    expect(testState.unlink).not.toHaveBeenCalled();
    expect(testState.preferences).toHaveBeenCalledExactlyOnceWith({
      target,
      publishAgentActivity: false,
    });
  });

  it("forgets a refused tunnel switch-off once another request goes through", async () => {
    testState.link.mockResolvedValue(accountConflict());
    await mountController();

    await act(async () => {
      await switchTunnelOff();
    });
    await act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: true, publish: true });
    });
    await act(async () => {
      await switchPublishingOff();
    });

    expect(testState.unlink).not.toHaveBeenCalled();
  });

  it("warns that the linking account still lists this PC when the last switch goes off", async () => {
    testState.linkState = { ...linkedWithBothSwitchesOn, publishAgentActivity: false };
    await mountController();

    await act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: false, publish: false });
    });

    expect(testState.unlink).toHaveBeenCalledOnce();
    expect(testState.toast).toHaveBeenCalledExactlyOnceWith(stillListedWarning);
  });
});
