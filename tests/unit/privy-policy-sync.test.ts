import { describe, expect, it, vi } from "vitest";
import { PrivyPolicySyncService } from "../../src/wallet/grants/privy-policy-sync.js";
import type { GrantPolicyProvisioner } from "../../src/wallet/grants/privy-policy-sync.js";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WALLET_ID = "wallet-1";

/**
 * DGC-4 / ADR-2: policy sync serialization must be per WALLET, not only per
 * grant. Two grants on the same wallet provision concurrently from different
 * app instances; the provider PATCH is a full-rule recompute, so unserialized
 * syncs can interleave and lose rules. The Postgres advisory lock is the
 * cross-instance serialization point and must be keyed by the wallet id.
 *
 * Note: the wallet lock is taken AFTER the grant row is read under the grant
 * lock, because syncRevocation's signature does not carry walletId — the key
 * is derived from the stored row (grant.wallet_id).
 */
function makeSync(grantOverrides: Partial<Record<string, unknown>> = {}): {
  sync: PrivyPolicySyncService;
  queries: Array<{ text: string; values: readonly unknown[] }>;
  provisionCalls: Array<Record<string, unknown>>;
  revokeCalls: unknown[];
} {
  const grantRow = {
    id: "grant-X",
    state: "active" as const,
    wallet_id: WALLET_ID,
    max_per_transfer: "1_000_000",
    max_cumulative: "5_000_000",
    window_seconds: 3_600,
    recipients: [RECIPIENT],
    provider_policy_id: null,
    chain: "solana-devnet",
    expires_at: new Date("2030-01-01T00:00:00.000Z"),
    ...grantOverrides,
  };
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  let grantIdAsked = "";
  const clientDouble = {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("FROM delegated_grants")) {
        grantIdAsked = String(values?.[0]);
        return grantRow.id === grantIdAsked
          ? { rows: [grantRow] }
          : { rows: [] };
      }
      return { rows: [] };
    }),
  };
  const databaseDouble = {
    withUserTransaction: async <T>(
      _userId: string,
      operation: (client: typeof clientDouble) => Promise<T>,
    ): Promise<T> => operation(clientDouble),
    query: clientDouble.query,
  };
  const provisionCalls: Array<Record<string, unknown>> = [];
  const revokeCalls: unknown[] = [];
  const provisioner = {
    async provisionPolicy(input: Record<string, unknown>) {
      provisionCalls.push(input);
      return { policyId: "policy-x" };
    },
    async revokePolicy(input: unknown) {
      revokeCalls.push(input);
    },
  };
  const sync = new PrivyPolicySyncService(
    databaseDouble as unknown as ConstructorParameters<
      typeof PrivyPolicySyncService
    >[0],
    provisioner as unknown as GrantPolicyProvisioner,
  );
  return { sync, queries, provisionCalls, revokeCalls };
}

/** Lock acquisitions on the client, in order. */
function lockCalls(
  queries: Array<{ text: string; values: readonly unknown[] }>,
): string[] {
  return queries
    .filter((q) => q.text.includes("pg_advisory_xact_lock"))
    .map((q) => String(q.values[0]));
}

describe("PrivyPolicySyncService per-wallet advisory lock (ADR-2)", () => {
  it("acquires a wallet-keyed advisory lock in syncGrant after the grant lock", async () => {
    const { sync, queries } = makeSync();
    await sync.syncGrant("grant-X", "user-1", WALLET_ID);
    const locks = lockCalls(queries);
    expect(locks).toEqual([`dgc-grant-grant-X`, `dgc-wallet-${WALLET_ID}`]);
  });

  it("acquires a wallet-keyed advisory lock in syncRevocation, derived from the stored row", async () => {
    const { sync, queries } = makeSync({
      provider_policy_id: "policy-existing",
    });
    await sync.syncRevocation("grant-X", "user-1");
    const locks = lockCalls(queries);
    expect(locks).toEqual([`dgc-grant-grant-X`, `dgc-wallet-${WALLET_ID}`]);
  });

  it("does not take a wallet lock when the grant does not exist", async () => {
    const { sync, queries } = makeSync();
    // The row double only answers for the seeded grant; assert the not-found path.
    await expect(
      sync.syncGrant("grant-missing", "user-1", WALLET_ID),
    ).rejects.toThrow(/not found/i);
    const locks = lockCalls(queries);
    expect(locks).toEqual([`dgc-grant-grant-missing`]);
  });

  it("passes the authenticated user and stored chain to the provisioner", async () => {
    const { sync, provisionCalls } = makeSync({ chain: "solana-devnet" });

    await sync.syncGrant("grant-X", "user-1", WALLET_ID);

    expect(provisionCalls[0]).toMatchObject({
      grantId: "grant-X",
      walletId: WALLET_ID,
      userId: "user-1",
      chain: "solana-devnet",
    });
  });

  it("passes grant and wallet identity into revocation recompute", async () => {
    const { sync, revokeCalls } = makeSync({
      chain: "solana-devnet",
      provider_policy_id: "policy-existing",
    });

    await sync.syncRevocation("grant-X", "user-1");

    expect(revokeCalls[0]).toEqual({
      grantId: "grant-X",
      userId: "user-1",
      walletId: WALLET_ID,
      chain: "solana-devnet",
      policyId: "policy-existing",
    });
  });
});
