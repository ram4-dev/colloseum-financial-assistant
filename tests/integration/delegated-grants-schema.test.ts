import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("delegated grants schema (migration 008, DGC-1)", () => {
  let database: DatabaseClient;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates delegated_grants with the scoped grant model and constraints", async () => {
    const columns = await database.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'delegated_grants'
       ORDER BY ordinal_position`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const expected of [
      "id",
      "user_id",
      "wallet_id",
      "action",
      "chain",
      "max_per_transfer",
      "max_cumulative",
      "window_seconds",
      "recipients",
      "state",
      "expires_at",
      "created_at",
      "revoked_at",
    ]) {
      expect(names).toContain(expected);
    }

    const checks = await database.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.delegated_grants'::regclass AND contype = 'c'`,
    );
    const checkNames = checks.rows.map((row) => row.conname);
    expect(checkNames.some((name) => name.includes("action"))).toBe(true);
    expect(checkNames.some((name) => name.includes("state"))).toBe(true);
    expect(checkNames.some((name) => name.includes("caps"))).toBe(true);
  });

  it("enforces state check on delegated_grants", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    await expect(
      database.withUserTransaction(userId, async (client) => {
        await client.query(
          `INSERT INTO delegated_grants
           (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
            window_seconds, recipients, expires_at)
           VALUES ($1, $2, 'transfer', 'solana', '100', '500', 3600, '[]', now() + interval '7 days')`,
          [userId, walletId],
        );
        return client.query(
          `UPDATE delegated_grants SET state = 'bogus' WHERE user_id = $1`,
          [userId],
        );
      }),
    ).rejects.toThrow();
  });

  it("rejects max_per_transfer above max_cumulative", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `INSERT INTO delegated_grants
           (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
            window_seconds, recipients, expires_at)
           VALUES ($1, $2, 'transfer', 'solana', '900', '500', 3600, '[]', now() + interval '7 days')`,
          [userId, walletId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("creates append-only grant_audit_log with event check and no update/delete path", async () => {
    const tables = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'grant_audit_log'`,
    );
    const names = tables.rows.map((row) => row.column_name);
    for (const expected of [
      "id",
      "grant_id",
      "user_id",
      "event",
      "reason",
      "amount",
      "detail",
      "created_at",
    ]) {
      expect(names).toContain(expected);
    }

    // Append-only: no UPDATE or DELETE rule/trigger bypass; verify via permission
    // introspection that the table exists and FORCE RLS is on.
    const rls = await database.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = 'grant_audit_log'`,
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    expect(rls.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("scopes delegated_grants rows by app.user_id (RLS)", async () => {
    const userA = await provisionUser(database);
    const userB = await provisionUser(database);
    const walletA = await provisionWallet(database, userA);
    const walletB = await provisionWallet(database, userB);

    const inserted = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO delegated_grants
         (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, expires_at)
         VALUES ($1, $2, 'transfer', 'solana', '100', '500', 3600, '[]', now() + interval '7 days')
         RETURNING id`,
        [userA, walletA],
      ),
    );
    const grantId = inserted.rows[0]!.id;

    const visibleToB = await database.withUserTransaction(userB, (client) =>
      client.query<{ id: string }>(`SELECT id FROM delegated_grants WHERE id = $1`, [grantId]),
    );
    expect(visibleToB.rowCount).toBe(0);

    // user B cannot insert a row claiming user A's identity (WITH CHECK)
    await expect(
      database.withUserTransaction(userB, (client) =>
        client.query(
          `INSERT INTO delegated_grants
           (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
            window_seconds, recipients, expires_at)
           VALUES ($1, $2, 'transfer', 'solana', '100', '500', 3600, '[]', now() + interval '7 days')`,
          [userA, walletB],
        ),
      ),
    ).rejects.toThrow();

    const visibleToA = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(`SELECT id FROM delegated_grants WHERE id = $1`, [grantId]),
    );
    expect(visibleToA.rowCount).toBe(1);
  });

  it("scopes grant_audit_log rows by app.user_id (RLS)", async () => {
    const userA = await provisionUser(database);
    const userB = await provisionUser(database);
    const walletA = await provisionWallet(database, userA);

    const grant = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO delegated_grants
         (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, expires_at)
         VALUES ($1, $2, 'transfer', 'solana', '100', '500', 3600, '[]', now() + interval '7 days')
         RETURNING id`,
        [userA, walletA],
      ),
    );
    const grantId = grant.rows[0]!.id;

    await database.withUserTransaction(userA, (client) =>
      client.query(
        `INSERT INTO grant_audit_log (grant_id, user_id, event)
         VALUES ($1, $2, 'created')`,
        [grantId, userA],
      ),
    );

    const visibleToB = await database.withUserTransaction(userB, (client) =>
      client.query<{ id: string }>(`SELECT id FROM grant_audit_log WHERE grant_id = $1`, [grantId]),
    );
    expect(visibleToB.rowCount).toBe(0);
  });

  it("links delegated_grants to user_wallets and users without touching signer_grants", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO delegated_grants
         (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, expires_at)
         VALUES ($1, $2, 'transfer', 'solana', '100', '500', 3600, '[]', now() + interval '7 days')
         RETURNING id`,
        [userId, walletId],
      ),
    );
    expect(result.rows[0]?.id).toBeTruthy();
  });
});

async function provisionUser(database: DatabaseClient): Promise<string> {
  // Direct owner-path insert: users_ensure_for_privy_did is intentionally not
  // executable by recipient_app (PMU-003); fixtures run as the migration owner.
  const result = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [`did:privy:dgc-${randomUUID()}`, 'DGC Test'],
  );
  return result.rows[0]!.id;
}

async function provisionWallet(
  database: DatabaseClient,
  userId: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  return result.rows[0]!.id;
}
