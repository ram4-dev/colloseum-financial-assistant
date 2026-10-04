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
    recipients: string[];
    maxPerTransfer: string;
    maxCumulative: string;
    windowSeconds: number;
  }): Promise<{ policyId: string }>;
  revokePolicy(policyId: string): Promise<void>;
};

export class PrivyPolicySyncService {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly provisioner: GrantPolicyProvisioner,
  ) {}

  /**
   * Provision (or re-provision) the policy for one grant. Never throws for
   * provider errors: the outcome is returned so the caller transaction commits
   * the fail-closed state + audit row. Throws only for grant-not-found.
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
      try {
        const { policyId } = await this.provisioner.provisionPolicy({
          grantId: grant.id,
          walletId: grant.wallet_id,
          recipients: grant.recipients as string[],
          maxPerTransfer: grant.max_per_transfer,
          maxCumulative: grant.max_cumulative,
          windowSeconds: grant.window_seconds,
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
            detail: { policyId },
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
          },
          client,
        );
        return { policyId: null, error: message };
      }
    });
  }

  /** Remove the provider enforcement surface for a revoked grant. */
  public async syncRevocation(grantId: string, userId: string): Promise<void> {
    await this.database.withUserTransaction(userId, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${grantId}`,
      ]);
      const grant = await this.lockedGrant(client, grantId, userId);
      if (!grant) {
        throw new Error(`Grant ${grantId} not found for this user.`);
      }
      if (grant.provider_policy_id) {
        await this.provisioner.revokePolicy(grant.provider_policy_id);
      }
      await client.query(
        `UPDATE delegated_grants SET provider_policy_id = NULL, updated_at = now()
         WHERE id = $1`,
        [grantId],
      );
    });
  }

  private async lockedGrant(
    client: Queryable,
    grantId: string,
    userId: string,
  ): Promise<{
    id: string;
    wallet_id: string;
    max_per_transfer: string;
    max_cumulative: string;
    window_seconds: number;
    recipients: unknown;
    provider_policy_id: string | null;
  } | null> {
    const result = await client.query<{
      id: string;
      wallet_id: string;
      max_per_transfer: string;
      max_cumulative: string;
      window_seconds: number;
      recipients: unknown;
      provider_policy_id: string | null;
    }>(
      `SELECT id, wallet_id, max_per_transfer, max_cumulative, window_seconds,
              recipients, provider_policy_id
       FROM delegated_grants WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [grantId, userId],
    );
    return result.rows[0] ?? null;
  }
}
