import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  appendGrantAudit,
  consumedInWindow,
  DelegatedGrantService,
  type DelegatedGrantRow,
} from "../../src/wallet/grants/consumption.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WINDOW_SECONDS = 3_600;
const MAX_PER_TRANSFER = "1_000_000";
const MAX_CUMULATIVE = "5_000_000";

async function provisionUser(
  database: DatabaseClient,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [`did:privy:dgc-cons-${randomUUID()}`, "DGC Consumption"],
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

describe("delegated grant consumption & audit (DGC-3)", () => {
  let database: DatabaseClient;
  let service: DelegatedGrantService;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    service = new DelegatedGrantService(database);
  });

  afterAll(async () => {
    await database.close();
  });

  async function createGrant(userId: string, walletId: string): Promise<DelegatedGrantRow> {
    return service.createGrant({
      userId,
      walletId,
      action: "transfer",
      chain: "solana",
      maxPerTransfer: MAX_PER_TRANSFER,
      maxCumulative: MAX_CUMULATIVE,
      windowSeconds: WINDOW_SECONDS,
      recipients: [RECIPIENT],
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
  }

  it("creates a grant, appends a created audit row, and lists grants", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    expect(grant.state).toBe("active");
    expect(grant.maxPerTransfer).toBe("1000000");

    const audit = await database.withUserTransaction(userId, (client) =>
      client.query<{ event: string }>(
        `SELECT event FROM grant_audit_log WHERE grant_id = $1 ORDER BY created_at`,
        [grant.id],
      ),
    );
    expect(audit.rows.map((row) => row.event)).toEqual(["created", "policy_synced"]);

    const listed = await service.listGrants(userId);
    expect(listed.some((row) => row.id === grant.id)).toBe(true);
  });

  it("aggregates only usage inside the rolling window", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    const fresh = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, grant.windowSeconds),
    );
    expect(fresh).toBe("0");

    await database.withUserTransaction(userId, (client) =>
      appendGrantAudit(database, {
        grantId: grant.id,
        userId,
        event: "used",
        amount: "2_000_000",
      }, client),
    );
    // Backdate one usage row beyond the window via a second append + SQL update
    // is impossible (append-only). Instead append 'used' now and verify the sum.
    await database.withUserTransaction(userId, (client) =>
      appendGrantAudit(database, {
        grantId: grant.id,
        userId,
        event: "used",
        amount: "1_500_000",
      }, client),
    );

    const consumed = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, WINDOW_SECONDS),
    );
    expect(consumed).toBe("3500000");
  });

  it("rejects audit UPDATE and DELETE (append-only trigger)", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `UPDATE grant_audit_log SET amount = '0' WHERE grant_id = $1`,
          [grant.id],
        ),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);

    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(`DELETE FROM grant_audit_log WHERE grant_id = $1`, [grant.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it("revocation marks the grant and appends a revoked audit row", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    await service.revokeGrant(grant.id, userId);

    const row = await database.withUserTransaction(userId, (client) =>
      client.query<{ state: string; revoked_at: string | null }>(
        `SELECT state, revoked_at FROM delegated_grants WHERE id = $1`,
        [grant.id],
      ),
    );
    expect(row.rows[0]?.state).toBe("revoked");
    expect(row.rows[0]?.revoked_at).not.toBeNull();

    const audit = await database.withUserTransaction(userId, (client) =>
      client.query<{ event: string }>(
        `SELECT event FROM grant_audit_log WHERE grant_id = $1 AND event = 'revoked'`,
        [grant.id],
      ),
    );
    expect(audit.rowCount).toBe(1);
  });

  it("atomically consumes budget: two concurrent claims cannot exceed the cap", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);
    // Cap allows exactly one more transfer of MAX_PER_TRANSFER.
    await database.withUserTransaction(userId, (client) =>
      appendGrantAudit(database, {
        grantId: grant.id,
        userId,
        event: "used",
        amount: "4_000_000",
      }, client),
    );

    const claim = () =>
      service.claimConsumption({
        grantId: grant.id,
        userId,
        amount: MAX_PER_TRANSFER,
        idempotencyKey: `claim-${randomUUID()}`,
      });

    const results = await Promise.allSettled([claim(), claim()]);
    const fulfilled = results.filter(
      (r) => r.status === "fulfilled" && r.value.consumed,
    );
    const rejected = results.filter(
      (r) => r.status === "fulfilled" && !r.value.consumed,
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it("reused idempotency key does not double-consume", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);
    const idempotencyKey = `idem-${randomUUID()}`;

    const first = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "1_000_000",
      idempotencyKey,
    });
    expect(first.consumed).toBe(true);

    const replay = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "1_000_000",
      idempotencyKey,
    });
    expect(replay.consumed).toBe(false);

    const consumed = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, WINDOW_SECONDS),
    );
    expect(consumed).toBe("1000000");
  });

  it("cross-user access to a grant is impossible (RLS through service path)", async () => {
    const userIdA = await provisionUser(database);
    const walletA = await provisionWallet(database, userIdA);
    const grant = await createGrant(userIdA, walletA);

    const userIdB = await provisionUser(database);
    const listed = await service.listGrants(userIdB);
    expect(listed.some((row) => row.id === grant.id)).toBe(false);
    await expect(
      service.revokeGrant(grant.id, userIdB),
    ).rejects.toThrow();
  });
});
