import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { PostgresConversationRepository } from "../../src/conversations/postgres-repository.js";
import type { PendingTransfer } from "../../src/contracts/http.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// Task 2.5 integration: real PostgresConversationRepository transitions write
// one assistant_lifecycle_outbox row per notification-worthy state ATOMICALLY
// with the attempt update; retryable/terminal-no-op paths write nothing, and
// an outbox failure rolls back the transition.
suite("assistant lifecycle outbox (repository transitions)", () => {
  let database: DatabaseClient;
  let repository: PostgresConversationRepository;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    repository = new PostgresConversationRepository(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const TRANSFER: PendingTransfer = {
    previewId: "",
    network: "solana-devnet",
    token: "SOL",
    amount: "0.1",
    recipientName: "Ana",
    recipientAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    feeLabel: "~0.000005 SOL",
  } as unknown as PendingTransfer;

  async function provisionConversation(): Promise<{
    userId: string;
    conversationId: string;
  }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:slice5-outbox-${randomUUID()}`, "Slice 5 Outbox"],
    );
    const userId = user.rows[0]!.id;
    const snapshot = await repository.create(userId);
    return { userId, conversationId: snapshot.id };
  }

  async function seedPreviewedAttempt(
    userId: string,
    conversationId: string,
  ): Promise<string> {
    // Pending attempt in previewed state (the normal claim entry point).
    const rows = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO conversation_transfer_attempts
         (conversation_id, user_id, state_revision, status, pending_transfer)
         VALUES ($1, $2, 1, 'previewed', $3::jsonb) RETURNING id`,
        [conversationId, userId, JSON.stringify(TRANSFER)],
      ),
    );
    return rows.rows[0]!.id;
  }

  async function outboxRows(
    userId: string,
    attemptId?: string,
  ): Promise<{ status: string; attempt_id: string; processed_at: Date | null }[]> {
    // Two fully static statements: no SQL fragment interpolation.
    const rows = attemptId
      ? await database.withUserTransactionAnonymous((client) =>
          client.query<{
            status: string;
            attempt_id: string;
            processed_at: Date | null;
          }>(
            `SELECT status, attempt_id, processed_at FROM assistant_lifecycle_outbox
         WHERE user_id = $1 AND attempt_id = $2
         ORDER BY created_at`,
            [userId, attemptId],
          ),
        )
      : await database.withUserTransactionAnonymous((client) =>
          client.query<{
            status: string;
            attempt_id: string;
            processed_at: Date | null;
          }>(
            `SELECT status, attempt_id, processed_at FROM assistant_lifecycle_outbox
         WHERE user_id = $1
         ORDER BY created_at`,
            [userId],
          ),
        );
    return rows.rows;
  }

  async function attemptStatus(
    userId: string,
    attemptId: string,
  ): Promise<string | null> {
    const rows = await database.withUserTransaction(userId, (client) =>
      client.query<{ status: string }>(
        `SELECT status FROM conversation_transfer_attempts WHERE id = $1 AND user_id = $2`,
        [attemptId, userId],
      ),
    );
    return rows.rows[0]?.status ?? null;
  }

  it("writes outbox rows atomically for submitted then finalized terminal states", async () => {
    const { userId, conversationId } = await provisionConversation();
    const attemptId = await seedPreviewedAttempt(userId, conversationId);

    await repository.claimPendingTransfer(userId, conversationId);
    await repository.markTransferSubmitted(userId, conversationId, "txhash-1");
    expect(await outboxRows(userId)).toEqual([
      { status: "submitted", attempt_id: attemptId, processed_at: null },
    ]);

    await repository.finalizeTransfer(userId, conversationId, {
      status: "confirmed",
      transactionHash: "txhash-1",
    });
    expect(await outboxRows(userId)).toEqual([
      { status: "submitted", attempt_id: attemptId, processed_at: null },
      { status: "confirmed", attempt_id: attemptId, processed_at: null },
    ]);
    expect(await attemptStatus(userId, attemptId)).toBe("confirmed");
  });

  it("emits uncertain on the uncertain path", async () => {
    const { userId, conversationId } = await provisionConversation();
    const attemptId = await seedPreviewedAttempt(userId, conversationId);
    await repository.claimPendingTransfer(userId, conversationId);
    await repository.markPendingTransferUncertain(userId, conversationId);
    expect(await outboxRows(userId)).toEqual([
      { status: "uncertain", attempt_id: attemptId, processed_at: null },
    ]);
  });

  it("emits nothing for previewed/cancelled/retry and zero-row stale updates", async () => {
    const { userId, conversationId } = await provisionConversation();
    const attemptId = await seedPreviewedAttempt(userId, conversationId);
    await repository.claimPendingTransfer(userId, conversationId);

    // Retryable path: not_dispatched returns to previewed — no outbox event.
    await repository.releasePendingTransferClaim(userId, conversationId);
    expect(await outboxRows(userId)).toHaveLength(0);

    // Zero-row stale update (already previewed): no outbox, no throw.
    await repository.markTransferSubmitted(userId, conversationId, "txhash-x");
    expect(await outboxRows(userId)).toHaveLength(0);
    expect(await attemptStatus(userId, attemptId)).toBe("previewed");

    // Cancelled attempt: cancelled is not notification-worthy.
    await database.withUserTransaction(userId, async (client) => {
      await client.query(
        `UPDATE conversation_transfer_attempts SET status = 'cancelled' WHERE id = $1`,
        [attemptId],
      );
    });
    expect(await outboxRows(userId)).toHaveLength(0);
  });

  it("emits reverted and receipt_invalid terminal outbox rows", async () => {
    for (const terminalStatus of ["reverted", "receipt_invalid"] as const) {
      const { userId, conversationId } = await provisionConversation();
      const attemptId = await seedPreviewedAttempt(userId, conversationId);
      await repository.claimPendingTransfer(userId, conversationId);
      await repository.markTransferSubmitted(
        userId,
        conversationId,
        `txhash-${terminalStatus}`,
      );
      await repository.finalizeTransfer(userId, conversationId, {
        status: terminalStatus,
        transactionHash: `txhash-${terminalStatus}`,
      });
      const rows = await outboxRows(userId, attemptId);
      expect(rows.map((row) => row.status)).toEqual([
        "submitted",
        terminalStatus,
      ]);
      expect(await attemptStatus(userId, attemptId)).toBe(terminalStatus);
    }
  });

  it("rolls back the attempt transition when the outbox insert fails", async () => {
    const { userId, conversationId } = await provisionConversation();
    const attemptId = await seedPreviewedAttempt(userId, conversationId);
    await repository.claimPendingTransfer(userId, conversationId);

    // Scoped trigger forces the outbox insert to fail inside the transaction.
    await database.query(
      `CREATE OR REPLACE FUNCTION slice5_outbox_fail() RETURNS trigger AS $fn$
       BEGIN RAISE EXCEPTION 'outbox forced failure'; END;
       $fn$ LANGUAGE plpgsql`,
    );
    await database.query(
      `CREATE TRIGGER slice5_outbox_fail_trigger
       BEFORE INSERT ON assistant_lifecycle_outbox
       FOR EACH ROW EXECUTE FUNCTION slice5_outbox_fail()`,
    );

    try {
      await expect(
        repository.markTransferSubmitted(
          userId,
          conversationId,
          "txhash-rollback",
        ),
      ).rejects.toThrow(/outbox forced failure/);

      // The attempt state must NOT have committed alone.
      expect(await attemptStatus(userId, attemptId)).toBe("broadcasting");
    } finally {
      // Cleanup cannot poison later tests sharing this database.
      await database.query(
        "DROP TRIGGER IF EXISTS slice5_outbox_fail_trigger ON assistant_lifecycle_outbox",
      );
      await database.query("DROP FUNCTION IF EXISTS slice5_outbox_fail()");
    }

    // After removing the trigger the same transition succeeds.
    await repository.markTransferSubmitted(userId, conversationId, "txhash-rollback");
    expect(await attemptStatus(userId, attemptId)).toBe("submitted");
    expect(await outboxRows(userId)).toEqual([
      { status: "submitted", attempt_id: attemptId, processed_at: null },
    ]);
  });
});
