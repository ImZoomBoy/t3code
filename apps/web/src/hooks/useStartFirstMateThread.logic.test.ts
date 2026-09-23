import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveFirstMateWorkingDirectory } from "./useStartFirstMateThread.logic";

describe("resolveFirstMateWorkingDirectory", () => {
  it("asks for the folder once when the setting is empty, and saves the answer", async () => {
    expect(DEFAULT_SERVER_SETTINGS.firstMateWorkingDirectory).toBe("");
    const pickFolder = vi.fn(async () => "D:/work/firstmate");
    const save = vi.fn();
    const path = await resolveFirstMateWorkingDirectory({
      configured: DEFAULT_SERVER_SETTINGS.firstMateWorkingDirectory,
      pickFolder,
      save,
    });
    expect(path).toBe("D:/work/firstmate");
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("D:/work/firstmate");
  });

  it("uses a saved folder without asking", async () => {
    const pickFolder = vi.fn(async () => "D:/elsewhere");
    const save = vi.fn();
    const path = await resolveFirstMateWorkingDirectory({
      configured: "D:/work/firstmate",
      pickFolder,
      save,
    });
    expect(path).toBe("D:/work/firstmate");
    expect(pickFolder).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("saves nothing when the picker is cancelled", async () => {
    const save = vi.fn();
    const path = await resolveFirstMateWorkingDirectory({
      configured: "",
      pickFolder: async () => null,
      save,
    });
    expect(path).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("points to the setting where no folder picker exists", async () => {
    await expect(
      resolveFirstMateWorkingDirectory({ configured: "", pickFolder: null, save: vi.fn() }),
    ).rejects.toThrow("First Mate working directory");
  });
});

describe("First Mate model setting", () => {
  it("defaults to Opus 5.5 with the 1M context, medium effort and fast mode off", () => {
    expect(DEFAULT_SERVER_SETTINGS.firstMateModelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "medium" },
        { id: "fastMode", value: false },
        { id: "contextWindow", value: "1m" },
      ],
    });
  });
});
