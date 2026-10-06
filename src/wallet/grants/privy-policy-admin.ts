/**
 * Task 2.7 — canonical Privy signer binding (ADR-2, D-4).
 *
 * Canonical identity rule: the signer that carries the composed grant policy is
 * the one persisted in `user_wallets.provider_signer_id`, resolved from the
 * local wallet UUID. No environment variable, key-quorum id, signer-list
 * position, or active grant row may ever select the signer.
 *
 * Fail-closed lifecycle:
 *   - `resolvePolicyTarget` maps the local wallet UUID to the exact
 *     `{providerWalletId, providerSignerId}` pair; a missing wallet row or a
 *     NULL signer binding throws before any provider operation.
 *   - `createPrivyPolicyAdmin` refuses a stored signer id equal to the Privy
 *     authorization key quorum id (a quorum id is never a signer id) and
 *     refuses zero/multiple remote signer matches before any mutation. The
 *     attach itself is a complete-list mutation that preserves every sibling
 *     signer untouched, followed by a signer-presence readback.
 *   - `backfillProviderSignerIds` writes the canonical column only when the
 *     historical `signer_grants.provider_signer_id` evidence for a wallet
 *     holds exactly one distinct non-null value; zero or conflicting evidence
 *     stays NULL (never guess). Callers run it under an anonymous/system
 *     transaction: backfill is not user-scoped work.
 */

import type { QueryableLike } from "../../db/client.js";

/** Exact provider-side policy target resolved from the local wallet UUID. */
export type PolicyTarget = {
  providerWalletId: string;
  providerSignerId: string;
};

/**
 * Narrow Privy mutation seam (security-hardened): only the exact signer-policy
 * attach is exposed — NEVER a generic arbitrary wallet PATCH. The underlying
 * client (`addPolicyToSigner`) requires exactly one matching signer, sends the
 * complete preserved signer list through the signed PATCH, and verifies the
 * post-mutation readback (exact policy id + intact siblings) before resolving.
 */
export type PrivyWalletSignerReader = {
  getWallet(providerWalletId: string): Promise<{
    additional_signers: Array<{
      signer_id: string;
      override_policy_ids?: string[];
      [key: string]: unknown;
    }>;
  }>;
  addPolicyToSigner(
    providerWalletId: string,
    signerId: string,
    policyId: string,
  ): Promise<void>;
};

export type PrivyPolicyAdminOptions = {
  privy: PrivyWalletSignerReader;
  database: QueryableLike;
  /** Privy authorization key quorum id; never a signer identity. */
  quorumId: string;
};

/**
 * Resolve the local wallet UUID to the exact provider wallet + signer pair.
 * Throws (fail closed) when the wallet row is missing or the signer binding
 * has not been persisted/verified yet.
 */
export async function resolvePolicyTarget(
  database: QueryableLike,
  walletId: string,
): Promise<PolicyTarget> {
  const result = await database.query<{
    id: string;
    provider_wallet_id: string;
    provider_signer_id: string | null;
    state: string;
  }>(
    `SELECT id, provider_wallet_id, provider_signer_id, state
     FROM user_wallets WHERE id = $1`,
    [walletId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Wallet ${walletId} not found; no policy target exists.`);
  }
  if (row.state !== "ready") {
    throw new Error(
      `Wallet ${walletId} is not ready (state: ${row.state}); refusing to resolve a policy target for a non-ready wallet.`,
    );
  }
  if (!row.provider_signer_id) {
    throw new Error(
      `Wallet ${walletId} has no verified provider signer binding; refusing to select a signer by inference.`,
    );
  }
  return {
    providerWalletId: row.provider_wallet_id,
    providerSignerId: row.provider_signer_id,
  };
}

export type PrivyPolicyAdmin = {
  /**
   * Attach `policyId` to the canonical signer of `walletId`. Fails closed on
   * quorum-id identity, missing/multiple remote signers, or a post-mutation
   * readback that no longer shows the signer exactly once with siblings
   * intact.
   */
  attachPolicyToSigner(input: {
    walletId: string;
    policyId: string;
  }): Promise<void>;
  /** Expose the resolved target for callers composing provider requests. */
  resolveTarget(walletId: string): Promise<PolicyTarget>;
};

export function createPrivyPolicyAdmin(
  options: PrivyPolicyAdminOptions,
): PrivyPolicyAdmin {
  const { privy, database, quorumId } = options;

  async function resolveTarget(walletId: string): Promise<PolicyTarget> {
    const target = await resolvePolicyTarget(database, walletId);
    if (target.providerSignerId === quorumId) {
      throw new Error(
        `Stored signer id equals the Privy authorization key quorum id for wallet ${walletId}; a quorum id is never a signer identity.`,
      );
    }
    return target;
  }

  function matchesFor(
    signers: Array<{ signer_id: string }>,
    signerId: string,
  ): Array<{ signer_id: string; override_policy_ids?: string[] }> {
    return signers.filter((signer) => signer.signer_id === signerId);
  }

  return {
    resolveTarget,

    async attachPolicyToSigner(input: {
      walletId: string;
      policyId: string;
    }): Promise<void> {
      const target = await resolveTarget(input.walletId);

      // Remote signer readback: exactly one match, before ANY mutation.
      const wallet = await privy.getWallet(target.providerWalletId);
      const signers = Array.isArray(wallet?.additional_signers)
        ? wallet.additional_signers
        : [];
      const matches = matchesFor(signers, target.providerSignerId);
      if (matches.length === 0) {
        throw new Error(
          `Remote wallet ${target.providerWalletId} shows no signer matching the stored signer id; refusing to attach.`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Remote wallet ${target.providerWalletId} shows ${matches.length} signers matching the stored signer id; refusing an ambiguous attach.`,
        );
      }

      // Narrow signed mutation through `addPolicyToSigner`: the Privy client
      // itself enforces the complete-list PATCH with authorization signature
      // and verifies the post-mutation readback (exact policy id + intact
      // sibling entries) before resolving.
      await privy.addPolicyToSigner(
        target.providerWalletId,
        target.providerSignerId,
        input.policyId,
      );
    },
  };
}

export type SignerBackfillReport = {
  walletsScanned: number;
  backfilled: number;
  leftNull: number;
  conflicted: number;
  /** Wallets skipped because a canonical binding already exists. */
  alreadyBound: number;
};

/**
 * Conservative backfill of `user_wallets.provider_signer_id` from historical
 * `signer_grants.provider_signer_id` evidence. Only a wallet whose non-null
 * evidence holds EXACTLY one distinct value is backfilled; zero or conflicting
 * evidence stays NULL (never guess). Must run under an anonymous/system
 * transaction (it spans wallets, not one user's request path).
 */
export async function backfillProviderSignerIds(
  database: QueryableLike,
): Promise<SignerBackfillReport> {
  const wallets = await database.query<{
    id: string;
    provider_signer_id: string | null;
  }>(`SELECT id, provider_signer_id FROM user_wallets ORDER BY created_at`);
  const report: SignerBackfillReport = {
    walletsScanned: wallets.rows.length,
    backfilled: 0,
    leftNull: 0,
    conflicted: 0,
    alreadyBound: 0,
  };
  for (const wallet of wallets.rows) {
    if (wallet.provider_signer_id) {
      // Already canonical: never rewrite an existing binding.
      report.alreadyBound += 1;
      continue;
    }
    const evidence = await database.query<{ provider_signer_id: string }>(
      `SELECT DISTINCT provider_signer_id FROM signer_grants
       WHERE wallet_id = $1 AND provider_signer_id IS NOT NULL`,
      [wallet.id],
    );
    const distinct = Array.from(
      new Set(evidence.rows.map((row) => row.provider_signer_id)),
    );
    if (distinct.length === 1) {
      // Predicate guards on IS NULL: concurrent backfills or a racing
      // enrollment write can never overwrite an existing canonical binding.
      await database.query(
        `UPDATE user_wallets SET provider_signer_id = $2, updated_at = now()
         WHERE id = $1 AND provider_signer_id IS NULL`,
        [wallet.id, distinct[0]],
      );
      report.backfilled += 1;
    } else if (distinct.length === 0) {
      report.leftNull += 1;
    } else {
      report.conflicted += 1;
    }
  }
  return report;
}
