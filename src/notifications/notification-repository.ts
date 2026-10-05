import type { Queryable } from "../db/client.js";
import type { DatabaseClient } from "../db/client.js";
import type {
 NotificationEvent,
 NotificationInsertOutcome,
} from "./ingestion.js";

/**
 * Owner-scoped idempotent insert for the canonical notification ledger.
 * Runs inside the resolved owner's transaction (app.user_id set) so the
 * table RLS policy applies, and relies on the unique (user_id, dedupe_key)
 * index: a replay conflict resolves to inserted=false (already canonical)
 * instead of an error.
 */
export async function insertNotificationRow(
 client: Queryable,
 event: NotificationEvent,
): Promise<NotificationInsertOutcome> {
 const result = await client.query<{ id: string }>(
  `INSERT INTO wallet_notifications
       (user_id, wallet_id, conversation_id, category, status, dedupe_key,
        title, explanation, resolved, projection)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING
     RETURNING id`,
  [
   event.userId,
   event.walletId ?? null,
   event.conversationId ?? null,
   event.category,
   event.status,
   event.dedupeKey,
   event.title,
   event.explanation ?? null,
   event.resolved ?? true,
   JSON.stringify(event.projection),
  ],
 );
 return { inserted: result.rows.length > 0 };
}

export type DatabaseNotificationIngestionDependencies = {
 database: DatabaseClient;
 publishInvalidation?: (event: NotificationEvent) => Promise<void>;
};

/**
 * Full database-backed ingestion: the insert commits inside the resolved
 * owner's transaction; the transient invalidation is only invoked after that
 * commit, and only by the winning insert.
 */
export async function ingestNotificationEventWithDatabase(
 event: NotificationEvent,
 dependencies: DatabaseNotificationIngestionDependencies,
): Promise<{ outcome: "inserted" | "already_canonical" }> {
 const outcome = await dependencies.database.withUserTransaction(
  event.userId,
  (client) => insertNotificationRow(client, event),
 );
 if (!outcome.inserted) return { outcome: "already_canonical" };
 if (dependencies.publishInvalidation) {
  await dependencies.publishInvalidation(event);
 }
 return { outcome: "inserted" };
}
