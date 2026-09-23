import {
  MessageId,
  NonNegativeInt,
  OrchestrationDeferredTurnStart,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const ProjectionThreadDeferredTurnStart = Schema.Struct({
  threadId: ThreadId,
  sequence: NonNegativeInt,
  turnStart: OrchestrationDeferredTurnStart,
});
export type ProjectionThreadDeferredTurnStart = typeof ProjectionThreadDeferredTurnStart.Type;

const ProjectionThreadDeferredTurnStartDbRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sequence: NonNegativeInt,
  turnStart: Schema.fromJsonString(OrchestrationDeferredTurnStart),
});

const DeleteProjectionThreadDeferredTurnStartInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});

const DeleteProjectionThreadDeferredTurnStartsInput = Schema.Struct({
  threadId: ThreadId,
});

/** Turn starts waiting for an idle thread. Written by the threads projector. */
export class ProjectionThreadDeferredTurnStartRepository extends Context.Service<
  ProjectionThreadDeferredTurnStartRepository,
  {
    readonly insert: (
      row: ProjectionThreadDeferredTurnStart,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly delete: (
      input: typeof DeleteProjectionThreadDeferredTurnStartInput.Type,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadId: (
      input: typeof DeleteProjectionThreadDeferredTurnStartsInput.Type,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()(
  "t3/persistence/ProjectionThreadDeferredTurnStarts/ProjectionThreadDeferredTurnStartRepository",
) {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: ProjectionThreadDeferredTurnStartDbRow,
    execute: (row) => sql`
      INSERT INTO projection_thread_deferred_turn_starts (
        thread_id,
        message_id,
        sequence,
        turn_start_json
      )
      VALUES (
        ${row.threadId},
        ${row.messageId},
        ${row.sequence},
        ${row.turnStart}
      )
      ON CONFLICT (thread_id, message_id) DO NOTHING
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteProjectionThreadDeferredTurnStartInput,
    execute: ({ threadId, messageId }) => sql`
      DELETE FROM projection_thread_deferred_turn_starts
      WHERE thread_id = ${threadId}
        AND message_id = ${messageId}
    `,
  });

  const deleteRows = SqlSchema.void({
    Request: DeleteProjectionThreadDeferredTurnStartsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_deferred_turn_starts
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    insert: (row) =>
      insertRow({ ...row, messageId: row.turnStart.message.messageId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadDeferredTurnStartRepository.insert:query"),
        ),
      ),
    delete: (input) =>
      deleteRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadDeferredTurnStartRepository.delete:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadDeferredTurnStartRepository.deleteByThreadId:query",
          ),
        ),
      ),
  } satisfies ProjectionThreadDeferredTurnStartRepository["Service"];
});

export const layer = Layer.effect(ProjectionThreadDeferredTurnStartRepository, make);
