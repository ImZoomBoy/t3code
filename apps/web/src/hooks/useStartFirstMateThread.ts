import { useAtomValue } from "@effect/atom-react";
import { FIRST_MATE_LABEL } from "@t3tools/client-runtime/fleet-threads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";

import { findProjectByPath, inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId, newThreadId } from "../lib/utils";
import { readProjects, waitForProject } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { readLocalApi } from "../localApi";
import { useUpdatePrimarySettings } from "./useSettings";
import { resolveFirstMateWorkingDirectory } from "./useStartFirstMateThread.logic";

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error && error.message.trim().length > 0 ? error : new Error(fallback);
}

/**
 * Start a new First Mate thread on the primary environment. It runs in the
 * directory the `firstMateWorkingDirectory` setting names, because First Mate
 * loads its instructions from there, asking for that folder the first time.
 * It runs on the `firstMateModelSelection` model. The directory becomes a
 * project if it is not one yet: a thread needs a project, even though the
 * sidebar shows First Mate outside every project. The server refuses a
 * second live First Mate thread. Resolves to null when the user cancels the
 * folder picker.
 */
export function useStartFirstMateThread(): () => Promise<ScopedThreadRef | null> {
  const primaryEnvironment = usePrimaryEnvironment();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const updatePrimarySettings = useUpdatePrimarySettings();

  return useCallback(async () => {
    const environmentId = primaryEnvironment?.environmentId ?? null;
    const serverConfig = environmentId === null ? null : serverConfigs.get(environmentId);
    if (environmentId === null || serverConfig == null) {
      throw new Error("T3 Code is not connected to this machine's environment.");
    }
    const pickFolder = readLocalApi()?.dialogs.pickFolder;
    const workspaceRoot = await resolveFirstMateWorkingDirectory({
      configured: serverConfig.settings.firstMateWorkingDirectory,
      pickFolder: window.desktopBridge && pickFolder ? () => pickFolder() : null,
      save: (path) => updatePrimarySettings({ firstMateWorkingDirectory: path }),
    });
    if (workspaceRoot === null) return null;

    let project =
      findProjectByPath(
        readProjects().filter((candidate) => candidate.environmentId === environmentId),
        workspaceRoot,
      ) ?? null;
    if (project === null) {
      const projectId = newProjectId();
      const created = await createProject({
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(workspaceRoot),
          workspaceRoot,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (created._tag === "Failure") {
        throw toError(squashAtomCommandFailure(created), "T3 Code could not add the project.");
      }
      project = await waitForProject({ environmentId, projectId });
    }

    const threadId = newThreadId();
    const result = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: project.id,
        title: FIRST_MATE_LABEL,
        modelSelection: serverConfig.settings.firstMateModelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        fleetRole: "first-mate",
        fleetRepo: null,
      },
    });
    if (result._tag === "Failure") {
      throw toError(squashAtomCommandFailure(result), "T3 Code could not start First Mate.");
    }
    return scopeThreadRef(environmentId, threadId);
  }, [
    createProject,
    createThread,
    primaryEnvironment?.environmentId,
    serverConfigs,
    updatePrimarySettings,
  ]);
}
