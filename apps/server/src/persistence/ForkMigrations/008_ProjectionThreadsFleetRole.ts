/**
 * A fleet thread's role and repository, so the sidebar can label and place it
 * without reading its title: the First Mate thread, a second mate for one
 * repository, or a worker. Both columns are nullable text with no default, so
 * every thread that existed before this migration reads back as an ordinary
 * thread, which is what every one of them is.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "fleet_role")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fleet_role TEXT
    `;
  }
  if (!columns.some((column) => column.name === "fleet_repo")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fleet_repo TEXT
    `;
  }
});
