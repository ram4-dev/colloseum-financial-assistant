import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { PostgresConversationRepository } from "../../src/conversations/postgres-repository.js";
import type { PendingTransfer } from "../../src/contracts/http.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { dispatchPendingAssistantOutbox } from "../../src/notifications/outbox-dispatcher.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("assistant outbox dispatcher PostgreSQL atomicity", () => {
  let database: DatabaseClient;
  let repository: PostgresConversationRepository;
  const created: Array<{ userId: string; conversationId: string; attemptId: string }> = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    repository = new PostgresConversationRepository(database);
  });

  afterAll(async () => {
    for (const item of created) {
      await database.withSystemTransaction(async (client) => {
        await client.query(
          "DELETE FROM wallet_notifications WHERE user_id = $1 AND dedupe_key LIKE $2",
          [item.userId, `assistant-transfer:${item.attemptId}:%`],
        );
        await client.query(
          "DELETE FROM assistant_lifecycle_outbox WHERE attempt_id = $1",
          [item.attemptId],
        );
      });
      await database.query("DELETE FROM conversations WHERE id = $1", [item.conversationId]);
      await database.query("DELETE FROM users WHERE id = $1", [item.userId]);
    }
    await database.close();
  });

  async function seedPendingSubmittedAttempt() {
    const userRows = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) RETURNING id`,
      [`did:privy:outbox-dispatch-${randomUUID()}`, "Outbox dispatcher test"],
    );
    const userId = userRows.rows[0]!.id;
    const conversation = await repository.create(userId);
    const transfer: PendingTransfer = {
      previewId: "",
      network: "solana-devnet",
      token: "SOL",
      amount: "0.01",
      recipientName: "Ana",
      recipientAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      feeLabel: "~0.000005 SOL",
    } as unknown as PendingTransfer;
    const attemptRows = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO conversation_transfer_attempts
         (conversation_id, user_id, state_revision, status, pending_transfer)
         VALUES ($1, $2, 0, 'previewed', $3::jsonb) RETURNING id`,
        [conversation.id, userId, JSON.stringify(transfer)],
      ),
    );
    const attemptId = attemptRows.rows[0]!.id;
    created.push({ userId, conversationId: conversation.id, attemptId });
    await repository.claimPendingTransfer(userId, conversation.id);
    await repository.markTransferSubmitted(userId, conversation.id, `tx-${attemptId}`);
    return { userId, conversationId: conversation.id, attemptId };
  }

  it("rolls notification insert back with outbox completion, retries once, then publishes after commit", async () => {
    const target = await seedPendingSubmittedAttempt();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `slice5_dispatch_fail_${suffix}`;
    const triggerName = `slice5_dispatch_fail_trigger_${suffix}`;
    await database.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger AS $fn$
       BEGIN RAISE EXCEPTION 'dispatcher completion forced failure'; END;
       $fn$ LANGUAGE plpgsql`,
    );
    await database.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE UPDATE OF processed_at ON assistant_lifecycle_outbox
       FOR EACH ROW WHEN (OLD.attempt_id = '${target.attemptId}'::uuid)
       EXECUTE FUNCTION ${functionName}()`,
    );

    const publishInvalidation = vi.fn(async () => undefined);
    try {
      await expect(
        dispatchPendingAssistantOutbox({
          database,
          userId: target.userId,
          publishInvalidation,
        }),
      ).rejects.toThrow("dispatcher completion forced failure");
      const rolledBack = await database.withUserTransaction(target.userId, (client) =>
        client.query<{ notification_count: string; processed_at: Date | null }>(
          `SELECT
             (SELECT count(*)::text FROM wallet_notifications WHERE user_id = $1
               AND dedupe_key = $2) AS notification_count,
             (SELECT processed_at FROM assistant_lifecycle_outbox
               WHERE attempt_id = $3 AND status = 'submitted') AS processed_at`,
          [target.userId, `assistant-transfer:${target.attemptId}:submitted`, target.attemptId],
        ),
      );
      expect(rolledBack.rows[0]?.notification_count).toBe("0");
      expect(rolledBack.rows[0]?.processed_at).toBeNull();
      expect(publishInvalidation).not.toHaveBeenCalled();
    } finally {
      await database.query(`DROP TRIGGER IF EXISTS ${triggerName} ON assistant_lifecycle_outbox`);
      await database.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    const postCommitObservations: Array<{ committed: boolean; revisionType: string }> = [];
    const publishAfterCommit = vi.fn(async (event: { conversationId: string; revision: number }) => {
      const rows = await database.withUserTransaction(target.userId, (client) =>
        client.query<{ processed_at: Date | null; notification_count: string }>(
          `SELECT
             (SELECT processed_at FROM assistant_lifecycle_outbox
               WHERE attempt_id = $1 AND status = 'submitted') AS processed_at,
             (SELECT count(*)::text FROM wallet_notifications WHERE user_id = $2
               AND dedupe_key = $3) AS notification_count`,
          [target.attemptId, target.userId, `assistant-transfer:${target.attemptId}:submitted`],
        ),
      );
      postCommitObservations.push({
        committed:
          rows.rows[0]?.processed_at instanceof Date &&
          rows.rows[0]?.notification_count === "1",
        revisionType: typeof event.revision,
      });
    });

    const result = await dispatchPendingAssistantOutbox({
      database,
      userId: target.userId,
      publishInvalidation: publishAfterCommit,
    });
    expect(result.dispatched).toBe(1);
    expect(publishAfterCommit).toHaveBeenCalledTimes(1);
    expect(postCommitObservations).toEqual([{ committed: true, revisionType: "number" }]);

    const replay = await dispatchPendingAssistantOutbox({
      database,
      userId: target.userId,
      publishInvalidation: publishAfterCommit,
    });
    expect(replay.dispatched).toBe(0);
    expect(publishAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("completes a dedupe loser without publishing another invalidation", async () => {
    const target = await seedPendingSubmittedAttempt();
    await database.withUserTransaction(target.userId, (client) =>
      client.query(
        `INSERT INTO wallet_notifications
           (user_id, conversation_id, category, status, dedupe_key, title, projection)
         VALUES ($1, $2, 'assistant_transfer', 'submitted', $3, 'Canonical', '{}'::jsonb)`,
        [
          target.userId,
          target.conversationId,
          `assistant-transfer:${target.attemptId}:submitted`,
        ],
      ),
    );
    const publishInvalidation = vi.fn(async () => undefined);

    const result = await dispatchPendingAssistantOutbox({
      database,
      userId: target.userId,
      publishInvalidation,
    });

    expect(result.dispatched).toBe(0);
    expect(publishInvalidation).not.toHaveBeenCalled();
    const rows = await database.withUserTransaction(target.userId, (client) =>
      client.query<{ processed_at: Date | null }>(
        `SELECT processed_at FROM assistant_lifecycle_outbox
         WHERE attempt_id = $1 AND status = 'submitted'`,
        [target.attemptId],
      ),
    );
    expect(rows.rows[0]?.processed_at).toBeInstanceOf(Date);
  });
});
