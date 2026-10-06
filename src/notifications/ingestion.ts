import { createHash } from "node:crypto";

export type NotificationEvent = {
 kind: "assistant_transfer" | "wallet_event";
 userId: string;
 walletId?: string;
 conversationId?: string;
 dedupeKey: string;
 category: "assistant_transfer" | "wallet_event";
 status: string;
 title: string;
 explanation?: string;
 resolved?: boolean;
 projection: Record<string, unknown>;
};

export type NotificationInsertOutcome = { inserted: boolean };

export type NotificationIngestionDependencies = {
 /**
  * Owner-scoped idempotent insert against the unique (user_id, dedupe_key)
  * identity. Must run inside the resolved owner's transaction and return
  * inserted=false when the row already exists (unique conflict treated as
  * already canonical).
  */
 insertNotification: (
  event: NotificationEvent,
 ) => Promise<NotificationInsertOutcome>;
 /**
  * Transient LiveKit conversation revision invalidation. Must only ever be
  * invoked by the insert winner after the notification is durably committed.
  */
 publishInvalidation?: (event: NotificationEvent) => Promise<void>;
};

export type IngestionResult = {
 outcome: "inserted" | "already_canonical";
};

/**
 * Canonical notification ingestion: one idempotent path for webhook, outbox,
 * and reconciliation events. The durable insert happens first; only the
 * winning insert publishes the transient invalidation, and a publish failure
 * can never roll back or hide the committed notification.
 */
export async function ingestNotificationEvent(
 event: NotificationEvent,
 dependencies: NotificationIngestionDependencies,
): Promise<IngestionResult> {
 const insert = await dependencies.insertNotification(event);
 if (!insert.inserted) {
  // Dedupe loser (webhook/poll overlap, outbox replay, delivery retry):
  // the notification is already canonical; never publish another fan-out.
  return { outcome: "already_canonical" };
 }
 if (dependencies.publishInvalidation) {
  await dependencies.publishInvalidation(event);
 }
 return { outcome: "inserted" };
}

export type ChainEventObservation = {
 network: string;
 walletAddress: string;
 signature: string;
 eventClass: string;
};

/**
 * Canonical chain-event dedupe key shared by webhook and reconciliation
 * paths: same network + wallet + signature + event class yields the same key
 * so overlapping observations collapse into one notification.
 */
export function canonicalDedupeKey(observation: ChainEventObservation): string {
 const digest = createHash("sha256")
  .update(
   [
    observation.network,
    observation.walletAddress,
    observation.signature,
    observation.eventClass,
   ].join("|"),
  )
  .digest("hex");
 return `chain:${observation.network}:${digest}`;
}
