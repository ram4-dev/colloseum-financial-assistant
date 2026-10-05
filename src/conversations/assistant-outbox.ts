import type { Queryable } from "../db/client.js";
import { ASSISTANT_NOTIFICATION_STATES } from "../notifications/assistant-state-mapping.js";

/**
 * Transactional outbox write for notification-worthy assistant attempt
 * transitions. MUST be called inside the same PostgreSQL transaction as the
 * `conversation_transfer_attempts` state update so process failure cannot
 * permanently lose the notification (SDD: attempt update + outbox row are
 * atomic; the dispatcher commits notification insert + outbox completion).
 *
 * Retryable transitions that return the attempt to `previewed`
 * (`not_dispatched`) produce no outbox row and stay conversation-only.
 */
export async function insertAssistantOutboxRow(
  client: Queryable,
  args: {
    attemptId: string;
    userId: string;
    status: string;
  },
): Promise<void> {
  if (!(ASSISTANT_NOTIFICATION_STATES as readonly string[]).includes(args.status)) {
    // previewed, broadcasting, cancelled, not_dispatched: no feed event.
    return;
  }
  await client.query(
    `INSERT INTO assistant_lifecycle_outbox (attempt_id, user_id, status, dedupe_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (attempt_id, status) DO NOTHING`,
    [
      args.attemptId,
      args.userId,
      args.status,
      `assistant-transfer:${args.attemptId}:${args.status}`,
    ],
  );
}
