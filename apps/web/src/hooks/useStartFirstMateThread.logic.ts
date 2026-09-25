/**
 * The folder a new First Mate thread runs in. The setting starts empty, so
 * the first "Start First Mate" asks for the folder with the app's folder picker
 * and saves the answer; every later start uses the saved folder. Null means
 * the user cancelled the picker.
 */
export async function resolveFirstMateWorkingDirectory(input: {
  readonly configured: string;
  readonly pickFolder: (() => Promise<string | null>) | null;
  readonly save: (path: string) => void;
}): Promise<string | null> {
  const configured = input.configured.trim();
  if (configured.length > 0) return configured;
  if (input.pickFolder === null) {
    throw new Error("Choose First Mate's folder in Settings, under First Mate working directory.");
  }
  const picked = (await input.pickFolder())?.trim() ?? "";
  if (picked.length === 0) return null;
  input.save(picked);
  return picked;
}
