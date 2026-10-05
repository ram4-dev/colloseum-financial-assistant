/**
 * Task 1.8 — canonical Privy signer binding (RED).
 *
 * Expected contract for the DB-backed policy target/admin adapter
 * (`src/wallet/grants/privy-policy-admin.ts`, to be implemented in GREEN):
 *
 *  - `resolvePolicyTarget(database, walletId)` resolves the local wallet UUID
 *    to `{ providerWalletId, providerSignerId }` from `user_wallets`
 *    (`provider_wallet_id` plus the persisted `provider_signer_id`).
 *  - The exact persisted signer id is required and must differ from the
 *    Privy authorization key quorum id (a quorum id is never a signer id).
 *  - NULL binding, conflicting backfill evidence, and remote zero/multiple
 *    signer matches fail BEFORE any policy create/attach/PATCH.
 *  - Attach is a complete-list mutation that preserves sibling signers.
 *  - Conservative backfill writes `user_wallets.provider_signer_id` only when
 *    the historical `signer_grants.provider_signer_id` evidence has exactly
 *    one distinct non-null value; zero or many stay NULL (never guess).
 *
 * These tests compile as far as possible (type-only imports are erased) and
 * fail only for the intentional missing module/behavior.
 */
import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../../src/db/client.js";

type PolicyTarget = { providerWalletId: string; providerSignerId: string };

type PolicyAdminModule = {
  resolvePolicyTarget(
    database: Queryable,
    walletId: string,
  ): Promise<PolicyTarget>;
  backfillProviderSignerIds(database: Queryable): Promise<{
    walletsScanned: number;
    backfilled: number;
    leftNull: number;
    conflicted: number;
    alreadyBound: number;
  }>;
  createPrivyPolicyAdmin(input: {
    privy: {
      getWallet(providerWalletId: string): Promise<{
        additional_signers: Array<{ signer_id: string }>;
      }>;
    };
    database: Queryable;
    quorumId: string;
  }): {
    attachPolicyToSigner(input: {
      walletId: string;
      policyId: string;
    }): Promise<void>;
  };
};

async function loadModule(): Promise<PolicyAdminModule> {
  // Indirect specifier: TS cannot statically resolve it, so this file typechecks
  // both in RED (module absent — vitest fails at runtime, exactly the intended
  // failure) and in GREEN once src/wallet/grants/privy-policy-admin.ts exists.
  const specifier = "../../src/wallet/grants/privy-policy-admin.js";
  return (await import(specifier)) as unknown as PolicyAdminModule;
}

const WALLET_UUID = "11111111-1111-1111-1111-111111111111";
const PROVIDER_WALLET_ID = "privy-wallet-1";
const SIGNER_ID = "signer-canonical-1";
const SIBLING_SIGNER_ID = "signer-sibling-9";
const QUORUM_ID = "quorum-not-a-signer";

function databaseDouble(rows: Record<string, unknown> = {}): Queryable & {
  queries: Array<{ text: string; values: readonly unknown[] }>;
} {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    queries.push({ text, values: values ?? [] });
    if (text.includes("user_wallets")) {
      return { rows: rows.userWallets ?? [] };
    }
    if (text.includes("signer_grants")) {
      return { rows: rows.signerGrants ?? [] };
    }
    return { rows: [] };
  }) as unknown as Queryable["query"];
  return { query, queries } as unknown as Queryable & {
    queries: Array<{ text: string; values: readonly unknown[] }>;
  };
}

function privyDouble(additionalSigners: Array<{ signer_id: string }>): {
  getWallet: ReturnType<typeof vi.fn>;
} {
  return {
    getWallet: vi.fn().mockResolvedValue({
      additional_signers: additionalSigners,
    }),
  };
}

describe("canonical signer binding — resolvePolicyTarget (task 1.8, RED)", () => {
  it("resolves the local wallet UUID to provider_wallet_id plus the persisted provider_signer_id", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
          state: "ready",
        },
      ],
    });
    const target = await mod.resolvePolicyTarget(database, WALLET_UUID);
    expect(target).toEqual({
      providerWalletId: PROVIDER_WALLET_ID,
      providerSignerId: SIGNER_ID,
    });
  });

  it("fails closed on a NULL persisted signer binding before any provider operation", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: null,
          state: "ready",
        },
      ],
    });
    await expect(
      mod.resolvePolicyTarget(database, WALLET_UUID),
    ).rejects.toThrow(/signer/i);
  });

  it("fails closed when the local wallet UUID has no wallet row", async () => {
    const mod = await loadModule();
    const database = databaseDouble({ userWallets: [] });
    await expect(
      mod.resolvePolicyTarget(database, WALLET_UUID),
    ).rejects.toThrow(/wallet/i);
  });

  it("fails closed when the wallet row is not in state ready", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
          state: "provisioning",
        },
      ],
    });
    await expect(
      mod.resolvePolicyTarget(database, WALLET_UUID),
    ).rejects.toThrow(/ready/i);
  });
});

describe("canonical signer binding — admin adapter (task 1.8, RED)", () => {
  it("refuses a stored signer id that equals the quorum id (a quorum id is never a signer id)", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: QUORUM_ID,
          state: "ready",
        },
      ],
    });
    const privy = privyDouble([{ signer_id: QUORUM_ID }]);
    const admin = mod.createPrivyPolicyAdmin({
      privy: privy as never,
      database,
      quorumId: QUORUM_ID,
    });
    await expect(
      admin.attachPolicyToSigner({
        walletId: WALLET_UUID,
        policyId: "policy-1",
      }),
    ).rejects.toThrow(/quorum/i);
  });

  it("fails closed on zero remote signer matches before any create/attach/PATCH", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
          state: "ready",
        },
      ],
    });
    // Remote wallet has only an unrelated sibling: the stored signer is absent.
    const privy = privyDouble([{ signer_id: SIBLING_SIGNER_ID }]);
    const admin = mod.createPrivyPolicyAdmin({
      privy: privy as never,
      database,
      quorumId: QUORUM_ID,
    });
    await expect(
      admin.attachPolicyToSigner({
        walletId: WALLET_UUID,
        policyId: "policy-1",
      }),
    ).rejects.toThrow(/signer/i);
  });

  it("fails closed on multiple remote signer matches before any create/attach/PATCH", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
          state: "ready",
        },
      ],
    });
    const privy = privyDouble([
      { signer_id: SIGNER_ID },
      { signer_id: SIGNER_ID },
    ]);
    const admin = mod.createPrivyPolicyAdmin({
      privy: privy as never,
      database,
      quorumId: QUORUM_ID,
    });
    await expect(
      admin.attachPolicyToSigner({
        walletId: WALLET_UUID,
        policyId: "policy-1",
      }),
    ).rejects.toThrow(/signer/i);
  });

  it("delegates the attach to the narrow signed Privy mutation with the exact resolved target", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
          state: "ready",
        },
      ],
    });
    const privy = {
      getWallet: vi.fn().mockResolvedValue({
        additional_signers: [
          { signer_id: SIGNER_ID },
          { signer_id: SIBLING_SIGNER_ID },
        ],
      }),
      addPolicyToSigner: vi.fn().mockResolvedValue(undefined),
    };
    const admin = mod.createPrivyPolicyAdmin({
      privy: privy as never,
      database,
      quorumId: QUORUM_ID,
    });
    await admin.attachPolicyToSigner({
      walletId: WALLET_UUID,
      policyId: "policy-1",
    });
    // The admin NEVER issues a generic wallet PATCH: the attach goes
    // through the narrow `addPolicyToSigner(providerWalletId, signerId,
    // policyId)` seam with the exact resolved canonical target.
    expect(privy.addPolicyToSigner).toHaveBeenCalledWith(
      PROVIDER_WALLET_ID,
      SIGNER_ID,
      "policy-1",
    );
  });

  it("propagates a failed Privy attach fail-closed (readback verification lives in the client)", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
          state: "ready",
        },
      ],
    });
    // The Privy client verifies the post-PATCH readback (exact policy id +
    // intact siblings) and rejects; the admin must surface that rejection,
    // never swallow it into a success.
    const privy = {
      getWallet: vi.fn().mockResolvedValue({
        additional_signers: [{ signer_id: SIGNER_ID }],
      }),
      addPolicyToSigner: vi
        .fn()
        .mockRejectedValue(new Error("post-attach readback unverified")),
    };
    const admin = mod.createPrivyPolicyAdmin({
      privy: privy as never,
      database,
      quorumId: QUORUM_ID,
    });
    await expect(
      admin.attachPolicyToSigner({
        walletId: WALLET_UUID,
        policyId: "policy-1",
      }),
    ).rejects.toThrow(/unverified/i);
  });
});

describe("conservative signer backfill (task 1.8, RED)", () => {
  it("leaves wallets with zero historical signer ids NULL (never fabricates)", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: null,
        },
      ],
      signerGrants: [],
    });
    const report = await mod.backfillProviderSignerIds(database);
    expect(report.backfilled).toBe(0);
    // No UPDATE may target the wallet: zero evidence stays NULL.
    const updates = database.queries.filter(
      (q) => /UPDATE/i.test(q.text) && q.text.includes("user_wallets"),
    );
    expect(updates).toHaveLength(0);
  });

  it("backfills the single distinct historical signer id", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: null,
        },
      ],
      signerGrants: [{ provider_signer_id: SIGNER_ID }],
    });
    const report = await mod.backfillProviderSignerIds(database);
    expect(report.backfilled).toBe(1);
    const updates = database.queries.filter(
      (q) => /UPDATE/i.test(q.text) && q.text.includes("user_wallets"),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values).toContain(SIGNER_ID);
    // Backfill only ever fills a NULL binding: the UPDATE predicate must guard
    // on provider_signer_id IS NULL (never rewrite an existing binding).
    expect(updates[0]?.text).toMatch(/IS NULL/i);
  });

  it("never rewrites an already-bound wallet even with single-distinct evidence", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
        },
      ],
      signerGrants: [{ provider_signer_id: "signer-historic-3" }],
    });
    const report = await mod.backfillProviderSignerIds(database);
    expect(report.alreadyBound).toBe(1);
    expect(report.backfilled).toBe(0);
    const updates = database.queries.filter(
      (q) => /UPDATE/i.test(q.text) && q.text.includes("user_wallets"),
    );
    expect(updates).toHaveLength(0);
  });

  it("never guesses when historical evidence holds conflicting signer ids", async () => {
    const mod = await loadModule();
    const database = databaseDouble({
      userWallets: [
        {
          id: WALLET_UUID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: null,
        },
      ],
      signerGrants: [
        { provider_signer_id: SIGNER_ID },
        { provider_signer_id: "signer-older-7" },
      ],
    });
    const report = await mod.backfillProviderSignerIds(database);
    expect(report.backfilled).toBe(0);
    expect(report.conflicted).toBe(1);
    const updates = database.queries.filter(
      (q) => /UPDATE/i.test(q.text) && q.text.includes("user_wallets"),
    );
    expect(updates).toHaveLength(0);
  });
});
