import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// RED: these tables do not exist until migration 013_wallet_notifications.sql
// (task 2.1) is applied; every assertion below must fail until then.
suite(
  "notifications schema, dedupe race, leases and RLS boundaries (Slice 5 RED)",
  () => {
    let database: DatabaseClient;

    beforeAll(async () => {
      database = createDatabaseClient(databaseUrl!);
    });

    afterAll(async () => {
      await database.close();
    });

    async function provisionUser(): Promise<string> {
      const result = await database.query<{ id: string }>(
        `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
        [`did:privy:slice5-${randomUUID()}`, "Slice 5 RED"],
      );
      return result.rows[0]!.id;
    }

    async function provisionWallet(
      userId: string,
      address: string,
    ): Promise<string> {
      const result = await database.query<{ id: string }>(
        `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
        [userId, `fixture-${randomUUID()}`, address],
      );
      return result.rows[0]!.id;
    }

    async function insertNotification(
      client: Parameters<
        Parameters<DatabaseClient["withUserTransaction"]>[1]
      >[0],
      values: { userId: string; dedupeKey: string; status: string },
    ): Promise<{ id: string }[]> {
      const result = await client.query<{ id: string }>(
        `INSERT INTO wallet_notifications (user_id, category, status, dedupe_key, projection)
       VALUES ($1, 'assistant_transfer', $3, $2, '{}') RETURNING id`,
        [values.userId, values.dedupeKey, values.status],
      );
      return result.rows;
    }

    it("creates wallet_notifications with (user_id, dedupe_key) unique and safe projection", async () => {
      const indexes = await database.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'wallet_notifications'`,
      );
      expect(
        indexes.rows.some(
          (row) =>
            row.indexname.includes("user_id") &&
            row.indexname.includes("dedupe"),
        ),
      ).toBe(true);

      const userA = await provisionUser();
      await database.withUserTransaction(userA, async (client) => {
        const inserted = await insertNotification(client, {
          userId: userA,
          dedupeKey: `assistant-transfer:${randomUUID()}:confirmed`,
          status: "confirmed",
        });
        expect(inserted).toHaveLength(1);
      });
    });

    it("rejects a duplicate (user_id, dedupe_key) insert: exactly one insert wins the concurrent race", async () => {
      const userA = await provisionUser();
      const dedupeKey = `assistant-transfer:${randomUUID()}:submitted`;

      // True concurrent race: exactly two separate transactions insert the
      // same (user_id, dedupe_key) simultaneously with no preinsert; exactly
      // one commits and the loser hits the unique conflict (SDD scenario:
      // webhook/poll overlap).
      const outcomes = await Promise.allSettled([
        database.withUserTransaction(userA, async (client) => {
          const rows = await insertNotification(client, {
            userId: userA,
            dedupeKey,
            status: "submitted",
          });
          return rows;
        }),
        database.withUserTransaction(userA, async (client) => {
          const rows = await insertNotification(client, {
            userId: userA,
            dedupeKey,
            status: "submitted",
          });
          return rows;
        }),
      ]);

      // Exactly one winner; the loser fails with the unique-constraint
      // violation (pg structured error code 23505).
      const winners = outcomes.filter(
        (outcome) => outcome.status === "fulfilled",
      );
      const losers = outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" &&
          (outcome as PromiseRejectedResult).reason?.code === "23505",
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(
        (winners[0] as PromiseFulfilledResult<{ id: string }[]>).value,
      ).toHaveLength(1);

      // The canonical row count for the raced dedupe key is exactly one.
      const canonical = await database.withUserTransaction(userA, (client) =>
        client.query<{ id: string }>(
          `SELECT id FROM wallet_notifications WHERE user_id = $1 AND dedupe_key = $2`,
          [userA, dedupeKey],
        ),
      );
      expect(canonical.rows).toHaveLength(1);
    });

    it("isolates the feed: user B cannot read or mutate user A notifications (RLS)", async () => {
      const userA = await provisionUser();
      const userB = await provisionUser();
      const dedupeKey = `assistant-transfer:${randomUUID()}:confirmed`;
      await database.withUserTransaction(userA, async (client) => {
        await insertNotification(client, {
          userId: userA,
          dedupeKey,
          status: "confirmed",
        });
      });

      const visibleToB = await database.withUserTransaction(userB, (client) =>
        client.query<{ id: string }>(
          `SELECT id FROM wallet_notifications WHERE user_id = $1`,
          [userA],
        ),
      );
      expect(visibleToB.rows).toHaveLength(0);

      const mutatedByB = await database.withUserTransaction(
        userB,
        async (client) => {
          // B attempts to mark A's notification read; RLS must make it a no-op.
          const update = await client.query<{ id: string }>(
            `UPDATE wallet_notifications SET read_at = now() WHERE user_id = $1 RETURNING id`,
            [userA],
          );
          return update.rows;
        },
      );
      expect(mutatedByB).toHaveLength(0);

      // System-context boundary (wallet-notifications spec): an anonymous
      // service transaction must not read nor modify user feed rows. The
      // system worker enumerates outbox references in anonymous context
      // and re-enters the resolved owner's transaction to touch the feed.
      const rowId = await database.withUserTransaction(userA, (client) =>
        client.query<{ id: string }>(
          `SELECT id FROM wallet_notifications WHERE user_id = $1`,
          [userA],
        ),
      );
      expect(rowId.rows).toHaveLength(1);
      const targetId = rowId.rows[0]!.id;

      const visibleToSystem = await database.withUserTransactionAnonymous(
        (client) =>
          client.query<{ id: string }>(
            `SELECT id FROM wallet_notifications WHERE id = $1`,
            [targetId],
          ),
      );
      expect(visibleToSystem.rows).toHaveLength(0);

      const mutatedBySystem = await database.withUserTransactionAnonymous(
        async (client) => {
          const update = await client.query<{ id: string }>(
            `UPDATE wallet_notifications SET read_at = now() WHERE id = $1 RETURNING id`,
            [targetId],
          );
          return update.rows;
        },
      );
      expect(mutatedBySystem).toHaveLength(0);
    });

    it("keeps webhook receipts and reconciliation cursors system-context-only", async () => {
      const userA = await provisionUser();
      // Anonymous service transaction (system context) may write receipts.
      await database.withUserTransactionAnonymous(async (client) => {
        await client.query(
          `INSERT INTO provider_webhook_receipts (provider, account_id, delivery_id)
         VALUES ('privy', 'acct-slice5-red', $1)`,
          [`delivery-${randomUUID()}`],
        );
      });

      // The same receipt is not writable (nor readable) inside a user feed transaction.
      await expect(
        database.withUserTransaction(userA, async (client) => {
          await client.query(
            `INSERT INTO provider_webhook_receipts (provider, account_id, delivery_id)
           VALUES ('privy', 'acct-slice5-red-user', $1)`,
            [`delivery-user-${randomUUID()}`],
          );
        }),
      ).rejects.toThrow();

      // Reconciliation cursors exist and are not exposed through user policies.
      const cursors = await database.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'reconciliation_cursors'`,
      );
      expect(cursors.rows.length).toBeGreaterThan(0);
    });

    it("advances reconciliation cursors with overlap-safe per-wallet identity", async () => {
      const userA = await provisionUser();
      const walletId = await provisionWallet(userA, `${randomUUID()}.sol`);
      // One active cursor row per (wallet, network); a second insert conflicts.
      await database.withUserTransactionAnonymous(async (client) => {
        await client.query(
          `INSERT INTO reconciliation_cursors (wallet_id, network, cursor_value, last_confirmed_signature)
         VALUES ($1, 'solana-devnet', 'slot-100', $2)`,
          [walletId, `${randomUUID()}`],
        );
      });
      await expect(
        database.withUserTransactionAnonymous(async (client) => {
          await client.query(
            `INSERT INTO reconciliation_cursors (wallet_id, network, cursor_value, last_confirmed_signature)
           VALUES ($1, 'solana-devnet', 'slot-200', $2)`,
            [walletId, `${randomUUID()}`],
          );
        }),
      ).rejects.toThrow();
    });

    it("excludes a second worker through the actual DB reconciliation lease", async () => {
      const userA = await provisionUser();
      const walletId = await provisionWallet(userA, `${randomUUID()}.sol`);

      const first = await database.withUserTransactionAnonymous(
        async (client) =>
          client.query<{ lease_token: string }>(
            `SELECT lease_token FROM acquire_reconciliation_lease($1, $2, $3)`,
            [walletId, "solana-devnet", "worker-one"],
          ),
      );
      expect(first.rows).toHaveLength(1);

      const second = await database.withUserTransactionAnonymous(
        async (client) =>
          client.query<{ lease_token: string | null }>(
            `SELECT lease_token FROM acquire_reconciliation_lease($1, $2, $3)`,
            [walletId, "solana-devnet", "worker-two"],
          ),
      );
      // The second worker must not acquire the lease while the first holds it.
      expect(second.rows[0]?.lease_token ?? null).toBeNull();
    });

    it("replays an unprocessed assistant outbox event after a simulated crash", async () => {
      const userA = await provisionUser();
      const attemptId = randomUUID();
      const dedupeKey = `assistant-transfer:${attemptId}:confirmed`;

      // Simulated attempt transition: state update + outbox row in one transaction.
      await database.withUserTransaction(userA, async (client) => {
        await client.query(
          `INSERT INTO assistant_lifecycle_outbox
           (attempt_id, user_id, status, dedupe_key)
           VALUES ($1, $2, 'confirmed', $3)`,
          [attemptId, userA, dedupeKey],
        );
      });

      // Crash simulation: the process stops here. After restart, the dispatcher
      // enumerates unprocessed outbox events in anonymous context.
      const pending = await database.withUserTransactionAnonymous((client) =>
        client.query<{ attempt_id: string; dedupe_key: string }>(
          `SELECT attempt_id, dedupe_key FROM assistant_lifecycle_outbox
         WHERE processed_at IS NULL AND user_id = $1`,
          [userA],
        ),
      );
      expect(pending.rows.map((row) => row.dedupe_key)).toContain(dedupeKey);

      // Recovery: notification insert + outbox completion commit atomically.
      await database.withUserTransaction(userA, async (client) => {
        await client.query(
          `INSERT INTO wallet_notifications (user_id, category, status, dedupe_key, projection)
         VALUES ($1, 'assistant_transfer', 'confirmed', $2, '{}')`,
          [userA, dedupeKey],
        );
        await client.query(
          `UPDATE assistant_lifecycle_outbox SET processed_at = now()
         WHERE attempt_id = $1 AND status = 'confirmed' AND processed_at IS NULL`,
          [attemptId],
        );
      });

      const remaining = await database.withUserTransactionAnonymous((client) =>
        client.query<{ id: string }>(
          `SELECT id FROM assistant_lifecycle_outbox
         WHERE attempt_id = $1 AND status = 'confirmed' AND processed_at IS NULL`,
          [attemptId],
        ),
      );
      expect(remaining.rows).toHaveLength(0);

      // A replayed dispatcher run must not create a second notification.
      await expect(
        database.withUserTransaction(userA, async (client) => {
          await client.query(
            `INSERT INTO wallet_notifications (user_id, category, status, dedupe_key, projection)
           VALUES ($1, 'assistant_transfer', 'confirmed', $2, '{}')`,
            [userA, dedupeKey],
          );
        }),
      ).rejects.toThrow();
    });
  },
);
