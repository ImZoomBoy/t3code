import { create } from "zustand";

/**
 * Which second mates have their workers folded away, by repository. The store
 * outlives the sidebar: Settings unmounts it, and coming back must not reopen
 * every second mate. Folding is a view choice for this app session, so it is
 * never saved or sent to the server.
 */
export const useFleetFolds = create<{
  readonly folded: ReadonlySet<string>;
  readonly toggle: (repo: string) => void;
}>((set) => ({
  folded: new Set(),
  toggle: (repo) =>
    set(({ folded }) => {
      const next = new Set(folded);
      if (!next.delete(repo)) next.add(repo);
      return { folded: next };
    }),
}));
