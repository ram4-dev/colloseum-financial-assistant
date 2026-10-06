/**
 * DGC-4: Privy policy sync driven by the grants ledger (hybrid D-4).
 *
 * The Postgres ledger is the single decision authority; this service projects
 * ledger state onto the provider enforcement surface: one Solana policy per
 * grant (per-transfer max, recipient allowlist, temporal window), evaluated in
 * the Privy enclave. Fail-closed: a provisioning error leaves the grant without
 * a provider_policy_id, so grant-covered execution can never proceed without
 * its enforcement surface. Every sync outcome is audited.
 */

import type { DatabaseClient, Queryable } from "../../db/client.js";
import { appendGrantAudit } from "./consumption.js";
export type GrantPolicyProvisioner = {
  /**
   * Create the provider policy for one grant. Input amounts are decimal
   * strings in the grant's smallest unit; recipients are chain-encoded
   * addresses (allowlist).
   */
  provisionPolicy(input: {
    grantId: string;
    walletId: string;
    userId: string;
    chain: string;
    recipients: string[];
    maxPerTransfer: string;
    maxCumulative: string;
    /** Stored ledger expiry (epoch seconds); never synthesized from a window. */
    expiresAt: number;
  }): Promise<{ policyId: string }>;
  revokePolicy(input: {
    grantId: string;
    walletId: string;
    userId: string;
    chain: string;
    policyId: string;
  }): Promise<void>;
};

/**
 * Fail-closed provisioner for a deployment without a provider policy adapter.
 *
 * Slice 1 ships no Solana policy adapter on purpose: the grants ledger is
 * chain-agnostic and stores amounts in the chain's smallest unit, while the Privy
 * policy envelope is denominated in atomic6 USDC (`GrantPolicyInput`). Converting
 * between them is a denomination decision that belongs to the Solana
 * WalletProvider in Slice 2, and guessing it here would install a ceiling that is
 * silently wrong by orders of magnitude.
 *
 * Every call is therefore refused, the refusal is audited as `policy_sync_failed`,
 * and the grant stays non-executable: exactly the same posture as a provider
 * outage. No policy binding is ever fabricated.
 */
export function createUnavailableGrantPolicyProvisioner(
  reason: string,
): GrantPolicyProvisioner {
  const refuse = (): never => {
    throw new Error(reason);
  };
  return {
    async provisionPolicy() {
      return refuse();
    },
    async revokePolicy() {
      return refuse();
    },
  };
}

export class PrivyPolicySyncService {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly provisioner: GrantPolicyProvisioner,
  ) {}

  /**
   * Provision (or re-provision) the policy for one grant. Never throws for
   * provider errors: the outcome is returned so the caller transaction commits
   * the fail-closed state + audit row. Throws only for grant-not-found.
   *
   * Idempotent: a grant that already holds a provider policy binding is not
   * provisioned a second time (which would leak a policy and rewrite the binding).
   * Slice 1 exposes no rotation path for a live grant; the ledger decides
   * creation and revocation only.
   */
  public async syncGrant(
    grantId: string,
    userId: string,
    walletId: string,
  ): Promise<{ policyId: string | null; error?: string }> {
    return this.database.withUserTransaction(userId, async (client) => {
      // Serialize sync against claim/revoke on the same grant.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${grantId}`,
      ]);
      const grant = await this.lockedGrant(client, grantId, userId);
      if (!grant) {
        throw new Error(`Grant ${grantId} not found for this user.`);
      }
      // Serialize policy sync per WALLET (ADR-2): provisions and revokes on
      // sibling grants of the same wallet each PATCH a full-rule recompute,
      // so unserialized syncs from different app instances can interleave
      // and lose rules. Cross-instance serialization point; taken after the
      // grant row is read because the key comes from the stored row.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-wallet-${grant.wallet_id}`,
      ]);
      if (grant.state !== "active") {
        // A revoke can win the race between ledger creation and this post-commit
        // sync call. Never provision a policy for an already-revoked grant.
        return {
          policyId: grant.provider_policy_id,
          error: "grant_not_active",
        };
      }
      if (grant.provider_policy_id) {
        return { policyId: grant.provider_policy_id };
      }
      try {
        const { policyId } = await this.provisioner.provisionPolicy({
          grantId: grant.id,
          walletId: grant.wallet_id,
          userId,
          chain: grant.chain,
          recipients: grant.recipients as string[],
          maxPerTransfer: grant.max_per_transfer,
          maxCumulative: grant.max_cumulative,
          // The stored TIMESTAMPTZ expiry, projected as epoch seconds. The
          // ledger expiry is authoritative; windowSeconds never synthesizes it.
          expiresAt: Math.floor(grant.expires_at.getTime() / 1000),
        });
        await client.query(
          `UPDATE delegated_grants SET provider_policy_id = $2, updated_at = now()
           WHERE id = $1`,
          [grantId, policyId],
        );
        await appendGrantAudit(
          this.database,
          {
            grantId,
            userId,
            event: "policy_synced",
            detail: { policyId, operation: "provision" },
          },
          client,
        );
        return { policyId };
      } catch (error) {
        // Fail-closed: clear any stale policy binding; the grant stays
        // non-executable until a successful sync.
        await client.query(
          `UPDATE delegated_grants SET provider_policy_id = NULL, updated_at = now()
           WHERE id = $1`,
          [grantId],
        );
        const message = error instanceof Error ? error.message : String(error);
        await appendGrantAudit(
          this.database,
          {
            grantId,
            userId,
            event: "policy_sync_failed",
            reason: message,
            detail: { operation: "provision" },
          },
          client,
        );
        return { policyId: null, error: message };
      }
    });
  }

  /**
   * Remove the provider enforcement surface for a revoked grant.
   *
   * The ledger revocation is already committed before this runs, so a provider
   * failure MUST NOT undo it or surface as an ambiguous failure of the revoke: the
   * outcome is returned, the failure is audited, and the binding is deliberately
   * KEPT so a retry can still remove the provider policy rather than leak it.
   * Execution stays blocked either way, because the grant state is `revoked`.
   */
  public async syncRevocation(
    grantId: string,
    userId: string,
  ): Promise<{ revoked: boolean; error?: string }> {
    return this.database.withUserTransaction(userId, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${grantId}`,
      ]);
      const grant = await this.lockedGrant(client, grantId, userId);
      if (!grant) {
        throw new Error(`Grant ${grantId} not found for this user.`);
      }
      // Wallet-keyed advisory lock (ADR-2): serialize this revoke's full-rule
      // recompute against concurrent provisions on sibling grants of the
      // same wallet, across app instances.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-wallet-${grant.wallet_id}`,
      ]);
      if (!grant.provider_policy_id) {
        // Nothing to remove: the ledger holds no enforcement binding.
        return { revoked: true };
      }
      try {
        await this.provisioner.revokePolicy({
          grantId: grant.id,
          walletId: grant.wallet_id,
          userId,
          chain: grant.chain,
          policyId: grant.provider_policy_id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendGrantAudit(
          this.database,
          {
            grantId,
            userId,
            event: "policy_sync_failed",
            reason: message,
            detail: { policyId: grant.provider_policy_id, operation: "revoke" },
          },
          client,
        );
        return { revoked: false, error: message };
      }
      await client.query(
        `UPDATE delegated_grants SET provider_policy_id = NULL, updated_at = now()
         WHERE id = $1`,
        [grantId],
      );
      await appendGrantAudit(
        this.database,
        {
          grantId,
          userId,
          event: "policy_synced",
          detail: { policyId: grant.provider_policy_id, operation: "revoke" },
        },
        client,
      );
      return { revoked: true };
    });
  }

  private async lockedGrant(
    client: Queryable,
    grantId: string,
    userId: string,
  ): Promise<{
    id: string;
    state: "active" | "revoked" | "expired";
    wallet_id: string;
    chain: string;
    max_per_transfer: string;
    max_cumulative: string;
    window_seconds: number;
    expires_at: Date;
    recipients: unknown;
    provider_policy_id: string | null;
  } | null> {
    const result = await client.query<{
      id: string;
      state: "active" | "revoked" | "expired";
      wallet_id: string;
      chain: string;
      max_per_transfer: string;
      max_cumulative: string;
      window_seconds: number;
      expires_at: Date;
      recipients: unknown;
      provider_policy_id: string | null;
    }>(
      `SELECT id, state, wallet_id, chain, max_per_transfer, max_cumulative, window_seconds,
              expires_at, recipients, provider_policy_id
       FROM delegated_grants WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [grantId, userId],
    );
    return result.rows[0] ?? null;
  }
}
