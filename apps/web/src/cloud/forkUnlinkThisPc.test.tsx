import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  signedInUserId: null as string | null,
  linkState: null as EnvironmentCloudLinkStateResult | null,
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
    error: null,
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

// The state the report describes: a link is stored, but there is no managed
// tunnel and publishing is off, so both switches show OFF.
const linkedWithBothSwitchesOff: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "account-that-linked",
  relayUrl: "https://relay.example.com",
  relayIssuer: "https://relay.example.com",
  managedTunnelActive: false,
  publishAgentActivity: false,
};

const accountConflict = new Error(
  "Could not configure environment relay access: This environment is already linked to a different cloud account. Unlink it before switching accounts.",
);

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
  it("unlinks a PC linked under another account with both switches off, without a relay token", async () => {
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
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.getToken).not.toHaveBeenCalled();
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalled();
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
  });

  it("points the different-account conflict at the unlink control", async () => {
    testState.link.mockResolvedValue(AsyncResult.failure(Cause.fail(accountConflict)));
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

  it("clears a shown conflict once the PC is unlinked", async () => {
    testState.link.mockResolvedValue(AsyncResult.failure(Cause.fail(accountConflict)));
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
    testState.link.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Could not obtain environment link proof."))),
    );
    await mountController();

    await act(async () => {
      await mounted().reconcileCloudState({ managedTunnel: true, publish: false });
    });

    expect(mounted().operationError).toBe("Could not obtain environment link proof.");
  });
});
