import type { DatabaseClient } from "../db/client.js";
import { insertNotificationRow } from "./notification-repository.js";
import { buildAssistantNotification } from "./assistant-state-mapping.js";

/**
 * Shared pending-event contract for the assistant lifecycle outbox. Both the
 * pure unit dispatcher and the real DB adapter operate on this shape, so the
 * crash/replay/dedupe guarantees are expressed once and verified twice.
 */
export type PendingAssistantOutboxEvent = {
  attemptId: string;
  userId: string;
  status: string;
  dedupeKey: string;
};

/**
 * Exact transient fan-out payload carried by the existing LiveKit
 * conversation_state_changed topic. Published only for insert winners,
 * strictly after the commit; a publish failure never affects delivery.
 */
export type OutboxInvalidation = {
  type: "conversation_state_changed";
  conversationId: string;
  revision: number;
};

/**
 * Atomic commit dependency: EITHER both the canonical notification insert and
 * the outbox completion land, OR neither does. This closes the crash gap the
 * SDD forbids — no separate insert/complete calls exist on this boundary.
 * A commit that resolves as an already-canonical dedupe loser returns
 * committed=false (and never publishes).
 */
export type AssistantOutboxDependencies = {
  loadPendingEvents: () => Promise<PendingAssistantOutboxEvent[]>;
  commitNotificationAndCompleteEvent: (
    event: PendingAssistantOutboxEvent,
  ) => Promise<{ committed: boolean; invalidation?: OutboxInvalidation }>;
  publishInvalidation?: (event: OutboxInvalidation) => Promise<void>;
};

export type DispatchResult = {
  dispatched: number;
};

/**
 * Pure dispatcher core: shared by the unit contract tests (fake deps) and the
 * real DB adapter below. A failing commit leaves the event pending; a
 * successful commit publishes the returned invalidation event (winner only,
 * post-commit, failure swallowed); a replay of committed state is a no-op.
 */
export async function dispatchPendingAssistantEvents(
  dependencies: AssistantOutboxDependencies,
): Promise<DispatchResult> {
  const pending = await dependencies.loadPendingEvents();
  let dispatched = 0;
  for (const event of pending) {
    const outcome =
      await dependencies.commitNotificationAndCompleteEvent(event);
    if (!outcome.committed) continue;
    dispatched += 1;
    if (outcome.invalidation && dependencies.publishInvalidation) {
      try {
        await dependencies.publishInvalidation(outcome.invalidation);
      } catch {
        // Transient fan-out must never affect committed delivery.
      }
    }
  }
  return { dispatched };
}

export type DispatchAssistantOutboxDependencies = {
  database: DatabaseClient;
  publishInvalidation?: (event: OutboxInvalidation) => Promise<void>;
  batchSize?: number;
  maxAttempts?: number;
  /**
   * Optional owner-scoped dispatch (safe per-user recovery and test
   * isolation). When set, only this user's pending events are enumerated;
   * production leaves it unset for the global retry loop.
   */
  userId?: string;
};

/**
 * Real DB adapter over the shared core: pending outbox rows are enumerated in
 * anonymous system context; each event is committed atomically inside the
 * resolved owner's transaction (notification insert via the shared canonical
 * primitive + outbox processed_at, winner AND dedupe loser alike). An absent
 * attempt row fails the run and leaves the event pending — never a
 * fabricated notification.
 */
export async function dispatchPendingAssistantOutbox(
  dependencies: DispatchAssistantOutboxDependencies,
): Promise<DispatchResult> {
  const database = dependencies.database;
  const batchSize = dependencies.batchSize ?? 100;

  const loadPendingEvents = async () => {
    // Two fully static statements: no SQL fragment interpolation.
    const rows = dependencies.userId
      ? await database.withSystemTransaction((client) =>
          client.query<{
            attempt_id: string;
            user_id: string;
            status: string;
            dedupe_key: string;
          }>(
            `SELECT attempt_id, user_id, status, dedupe_key
         FROM assistant_lifecycle_outbox
         WHERE processed_at IS NULL AND user_id = $1
         ORDER BY created_at
         LIMIT $2`,
            [dependencies.userId, batchSize],
          ),
        )
      : await database.withSystemTransaction((client) =>
          client.query<{
            attempt_id: string;
            user_id: string;
            status: string;
            dedupe_key: string;
          }>(
            `SELECT attempt_id, user_id, status, dedupe_key
         FROM assistant_lifecycle_outbox
         WHERE processed_at IS NULL
         ORDER BY created_at
         LIMIT $1`,
            [batchSize],
          ),
        );
    return rows.rows.map((row) => ({
      attemptId: row.attempt_id,
      userId: row.user_id,
      status: row.status,
      dedupeKey: row.dedupe_key,
    }));
  };

  const commitNotificationAndCompleteEvent = async (
    event: PendingAssistantOutboxEvent,
  ) => {
    let committed = false;
    let invalidation: OutboxInvalidation | undefined;
    await database.withUserTransaction(event.userId, async (client) => {
      const attempt = await client.query<{
        conversation_id: string;
        pending_transfer: Record<string, unknown> | null;
        transaction_hash: string | null;
      }>(
        `SELECT a.conversation_id, a.pending_transfer, a.transaction_hash
         FROM conversation_transfer_attempts a
         WHERE a.id = $1 AND a.user_id = $2`,
        [event.attemptId, event.userId],
      );
      const row = attempt.rows[0];
      if (!row) {
        // Orphan/corrupt outbox event: fail the run and leave the event
        // pending for a maintainer decision — never a fabricated notification.
        throw new Error(
          `Outbox event ${event.dedupeKey} references missing attempt ${event.attemptId}.`,
        );
      }
      const revisionRow = await client.query<{ revision: string | number }>(
        `SELECT revision FROM conversation_state
         WHERE conversation_id = $1 AND user_id = $2`,
        [row.conversation_id, event.userId],
      );
      // int8 arrives as a string through node-postgres; coerce and validate so
      // the LiveKit payload carries a finite numeric revision (the frontend
      // drops non-number revisions).
      const rawRevision = Number(revisionRow.rows[0]?.revision ?? 0);
      const revision = Number.isSafeInteger(rawRevision) ? rawRevision : 0;
      const preview = row.pending_transfer as
        | { amount?: string; token?: string; network?: string }
        | undefined;
      const notification = buildAssistantNotification({
        attemptId: event.attemptId,
        conversationId: row.conversation_id,
        userId: event.userId,
        status: event.status as never,
        amountLabel:
          preview?.amount !== undefined && preview?.token !== undefined
            ? `${preview.amount} ${preview.token}`
            : undefined,
        network: preview?.network,
        transactionHash: row.transaction_hash ?? undefined,
      });

      // Canonical shared insert primitive (same one the webhook and the
      // reconciler use): unique (user_id, dedupe_key) dedupe, safe projection.
      const insert = await insertNotificationRow(client, {
        kind: "assistant_transfer",
        userId: event.userId,
        conversationId: row.conversation_id,
        dedupeKey: event.dedupeKey,
        category: "assistant_transfer",
        status: notification.status,
        title: notification.title,
        explanation: notification.explanation,
        resolved: notification.resolved,
        projection: notification.projection,
      });
      // Mark processed in the SAME owner transaction for both winner and
      // dedupe loser: the loser confirmed the canonical row exists — no
      // post-commit completion gap.
      await client.query(
        `UPDATE assistant_lifecycle_outbox SET processed_at = now()
         WHERE attempt_id = $1 AND status = $2 AND processed_at IS NULL`,
        [event.attemptId, event.status],
      );
      if (insert.inserted) {
        committed = true;
        invalidation = {
          type: "conversation_state_changed",
          conversationId: row.conversation_id,
          revision,
        };
      }
    });
    return { committed, invalidation };
  };

  return dispatchPendingAssistantEvents({
    loadPendingEvents,
    commitNotificationAndCompleteEvent,
    publishInvalidation: dependencies.publishInvalidation,
  });
}
