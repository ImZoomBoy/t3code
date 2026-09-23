/**
 * Turn starts waiting for their thread to go idle. A row lives from the
 * `thread.turn-start-deferred` event until the turn starts or the thread is
 * archived or deleted, and the command model loads the rows at startup, so a
 * waiting turn start survives a restart. The whole start is kept as JSON
 * because nothing queries inside it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_deferred_turn_starts (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      turn_start_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;
});
