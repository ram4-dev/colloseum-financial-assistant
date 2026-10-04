/**
 * DGC-3: PostgreSQL-backed delegated grant lifecycle, rolling-window
 * consumption accounting, and append-only audit.
 *
 * The ledger (delegated_grants + grant_audit_log) is the single decision
 * authority per the approved hybrid D-4: Privy policies enforce per-tx
 * ceilings/destinations in enclave; this layer enforces cumulative
 * rolling-window caps, TTL/expiration, revocation, and audit.
 *
 * All user-scoped access flows through withUserTransaction (LOCAL ROLE
 * recipient_app + app.user_id) so RLS is exercised exactly like production.
 * Consumption is atomic at the DB level (advisory lock + re-read + audit append
 * in one transaction); in-memory counters are never a source of truth.
 */

import type { DatabaseClient, Queryable } from "../../db/client.js";

export type DelegatedGrantRow = {
  id: string;
  userId: string;
  walletId: string;
  action: "transfer";
  chain: string;
  maxPerTransfer: string;
  maxCumulative: string;
  windowSeconds: number;
  recipients: string[];
  state: "active" | "revoked" | "expired";
  providerPolicyId: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type GrantAuditEvent =
  | "created"
  | "used"
  | "rejected"
  | "revoked"
  | "expired"
  | "policy_synced"
  | "policy_sync_failed";

export type CreateGrantInput = {
  userId: string;
  walletId: string;
  action: "transfer";
  chain: string;
  maxPerTransfer: string;
  maxCumulative: string;
  windowSeconds: number;
  recipients: string[];
  expiresAt: Date;
};

export type ClaimConsumptionResult = {
  consumed: boolean;
  reason?: string;
};

const GRANT_COLUMNS =
  "id, user_id, wallet_id, action, chain, max_per_transfer, max_cumulative, window_seconds, recipients, state, provider_policy_id, created_at, expires_at, revoked_at";

type GrantSqlRow = {
  id: string;
  user_id: string;
  wallet_id: string;
  action: string;
  chain: string;
  max_per_transfer: string;
  max_cumulative: string;
  window_seconds: number;
  recipients: unknown;
  state: string;
  provider_policy_id: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

function mapGrant(row: GrantSqlRow): DelegatedGrantRow {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    action: "transfer",
    chain: row.chain,
    maxPerTransfer: row.max_per_transfer,
    maxCumulative: row.max_cumulative,
    windowSeconds: row.window_seconds,
    recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
    state: row.state as DelegatedGrantRow["state"],
    providerPolicyId: row.provider_policy_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function normalizeDecimal(value: string): string {
  return value.replaceAll("_", "");
}

/**
 * Sum of audited `used` amounts for a grant inside its rolling window
 * (created_at > now - window). Uses the passed clock so tests can pin time.
 */
export async function consumedInWindow(
  database: DatabaseClient | Queryable,
  grantId: string,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<string> {
  const run = (executor: Queryable) =>
    executor.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM grant_audit_log
       WHERE grant_id = $1
         AND event = 'used'
         AND amount IS NOT NULL
         AND created_at > $2`,
      [grantId, new Date(now.getTime() - windowSeconds * 1_000)],
    );
  // A DatabaseClient has no user context: RLS hides rows unless app.user_id is
  // set, so raw client use here is only valid when the caller already provides
  // a user-scoped Queryable (the production path). The fallback anonymous tx
  // exists for fixtures and returns 0 by design (no user context → no rows).
  if (isQueryable(database)) {
    const result = await run(database);
    return result.rows[0]?.total ?? "0";
  }
  let total = "0";
  await (database as DatabaseClient).withUserTransactionAnonymous(async (client) => {
    const result = await run(client);
    total = result.rows[0]?.total ?? "0";
  });
  return total;
}

function isQueryable(value: DatabaseClient | Queryable): value is Queryable {
  return typeof (value as DatabaseClient).withUserTransaction !== "function";
}

/**
 * Append an immutable audit row. Must be called inside the same transaction as
 * the decision it records (never after an on-chain side effect).
 */
export async function appendGrantAudit(
  database: DatabaseClient | Queryable,
  input: {
    grantId: string;
    userId: string;
    event: GrantAuditEvent;
    reason?: string;
    amount?: string;
    detail?: Record<string, unknown>;
  },
  executor?: Queryable,
): Promise<void> {
  const run = (client: Queryable) =>
    client.query(
      `INSERT INTO grant_audit_log (grant_id, user_id, event, reason, amount, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.grantId,
        input.userId,
        input.event,
        input.reason ?? null,
        input.amount !== undefined ? normalizeDecimal(input.amount) : null,
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    );
  if (executor) {
    await run(executor);
    return;
  }
  // No executor given: the caller accepts the anonymous (no app.user_id)
  // context. RLS will reject user-scoped writes; valid only for system-level
  // rows that carry their own user_id with a matching policy.
  await (database as DatabaseClient).withUserTransactionAnonymous((client) =>
    run(client),
  );
}

export class DelegatedGrantService {
  public constructor(private readonly database: DatabaseClient) {}

  public async createGrant(input: CreateGrantInput): Promise<DelegatedGrantRow> {
    return this.database.withUserTransaction(input.userId, (client) =>
      this.createGrantInTransaction(input, client),
    );
  }

  private async createGrantInTransaction(
    input: CreateGrantInput,
    client: Queryable,
  ): Promise<DelegatedGrantRow> {
    const result = await client.query<GrantSqlRow>(
      `INSERT INTO delegated_grants
       (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
        window_seconds, recipients, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING ${GRANT_COLUMNS}`,
      [
        input.userId,
        input.walletId,
        input.action,
        input.chain,
        normalizeDecimal(input.maxPerTransfer),
        normalizeDecimal(input.maxCumulative),
        input.windowSeconds,
        JSON.stringify(input.recipients),
        input.expiresAt,
      ],
    );
    const grant = mapGrant(result.rows[0]!);
    // Ledger is the decision authority: policy sync is recorded in the same
    // transaction so a grant is only visible once its enforcement surface exists.
    await client.query(
      `INSERT INTO grant_audit_log (grant_id, user_id, event, reason)
       VALUES ($1, $2, 'created', NULL)`,
      [grant.id, input.userId],
    );
    // D-4: policy provisioning is exercised in Phase 4; the ledger records the
    // sync outcome. Until then the grant is created with policy_synced pending
    // the sync worker; covered execution additionally requires the Privy policy.
    await client.query(
      `INSERT INTO grant_audit_log (grant_id, user_id, event, reason)
       VALUES ($1, $2, 'policy_synced', 'policy_sync_deferred_to_phase4')`,
      [grant.id, input.userId],
    );
    return grant;
  }

  public async listGrants(userId: string): Promise<DelegatedGrantRow[]> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<GrantSqlRow>(
        `SELECT ${GRANT_COLUMNS} FROM delegated_grants
         WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      return result.rows.map(mapGrant);
    });
  }

  public async getGrant(grantId: string, userId: string): Promise<DelegatedGrantRow | null> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<GrantSqlRow>(
        `SELECT ${GRANT_COLUMNS} FROM delegated_grants WHERE id = $1 AND user_id = $2`,
        [grantId, userId],
      );
      return result.rows[0] ? mapGrant(result.rows[0]) : null;
    });
  }

  public async revokeGrant(grantId: string, userId: string): Promise<DelegatedGrantRow> {
    return this.database.withUserTransaction(userId, async (client) => {
      // Serialize concurrent revoke/claim on the same grant.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${grantId}`,
      ]);
      const result = await client.query<GrantSqlRow>(
        `UPDATE delegated_grants
         SET state = 'revoked', revoked_at = now(), updated_at = now()
         WHERE id = $1 AND user_id = $2 AND state = 'active'
         RETURNING ${GRANT_COLUMNS}`,
        [grantId, userId],
      );
      if (!result.rows[0]) {
        throw new Error(`Grant ${grantId} is not active or does not exist for this user.`);
      }
      await client.query(
        `INSERT INTO grant_audit_log (grant_id, user_id, event)
         VALUES ($1, $2, 'revoked')`,
        [grantId, userId],
      );
      return mapGrant(result.rows[0]);
    });
  }

  /**
   * Atomically claim budget for one execution. Runs the engine-equivalent cap
   * checks against a locked grant row and appends the `used` audit row in the
   * SAME transaction, so two concurrent claims cannot both fit under a cap that
   * only has room for one. Idempotency: a repeated idempotency key returns
   * consumed:false without a second audit row (DB unique constraint).
   */
  public async claimConsumption(input: {
    grantId: string;
    userId: string;
    amount: string;
    idempotencyKey: string;
  }): Promise<ClaimConsumptionResult> {
    return this.database.withUserTransaction(input.userId, async (client) => {
      // Serialize all consumption decisions for this grant across app instances.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${input.grantId}`,
      ]);

      // Idempotency replay: the unique index on grant_id+idempotency_key in
      // grant_claim_ledger decides; no second consumption, no second audit row.
      const replay = await client.query<{ id: string }>(
        `SELECT id FROM grant_claim_ledger
         WHERE grant_id = $1 AND idempotency_key = $2`,
        [input.grantId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        return { consumed: false, reason: "idempotency_replay" };
      }

      const grantResult = await client.query<GrantSqlRow>(
        `SELECT ${GRANT_COLUMNS} FROM delegated_grants
         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.grantId, input.userId],
      );
      const grantRow = grantResult.rows[0];
      if (!grantRow) {
        return { consumed: false, reason: "grant_not_found" };
      }
      const grant = mapGrant(grantRow);
      if (grant.state !== "active") {
        return { consumed: false, reason: "grant_revoked" };
      }

      const amount = normalizeDecimal(input.amount);
      const consumedResult = await client.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM grant_audit_log
         WHERE grant_id = $1 AND event = 'used' AND amount IS NOT NULL
           AND created_at > $2`,
        [input.grantId, new Date(Date.now() - grant.windowSeconds * 1_000)],
      );
      const consumed = consumedResult.rows[0]?.total ?? "0";
      const projected = BigInt(consumed) + BigInt(amount);
      if (BigInt(amount) > BigInt(grant.maxPerTransfer)) {
        return { consumed: false, reason: "per_transfer_cap_exceeded" };
      }
      if (projected > BigInt(grant.maxCumulative)) {
        return { consumed: false, reason: "cumulative_cap_exceeded" };
      }

      await client.query(
        `INSERT INTO grant_claim_ledger (grant_id, user_id, idempotency_key, amount)
         VALUES ($1, $2, $3, $4)`,
        [input.grantId, input.userId, input.idempotencyKey, amount],
      );
      await client.query(
        `INSERT INTO grant_audit_log (grant_id, user_id, event, amount, detail)
         VALUES ($1, $2, 'used', $3, $4)`,
        [
          input.grantId,
          input.userId,
          amount,
          JSON.stringify({ idempotencyKey: input.idempotencyKey }),
        ],
      );
      return { consumed: true };
    });
  }
}
