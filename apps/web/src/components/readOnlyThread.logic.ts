/**
 * Whether the command palette offers "Restart agent session" on a thread. The
 * restart takes effect on the next message, and a read-only thread has no
 * composer to send one from. First Mate still stops a worker's session through
 * the server.
 */
export function offersSessionRestart(thread: { readonly readOnly?: boolean | undefined }): boolean {
  return thread.readOnly !== true;
}
