/**
 * Marks a user message a fleet wake sent, so clients fold it into a notice
 * instead of showing it as something the user typed. See
 * `ThreadTurnStartCommand.fleetWake`.
 *
 * An integer because SQLite has no boolean type, as with `fleet_owned` in
 * fork migration 7. `NOT NULL DEFAULT 0` fills every existing row with `0`,
 * so every message sent before this migration reads back unmarked.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "fleet_wake")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN fleet_wake INTEGER NOT NULL DEFAULT 0
    `;
  }
});
