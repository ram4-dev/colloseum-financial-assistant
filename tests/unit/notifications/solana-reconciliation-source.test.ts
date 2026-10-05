import { describe, expect, it } from "vitest";

import {
  createSolanaDevnetReconciliationSource,
  type SolanaReconciliationRpc,
} from "../../../src/notifications/solana-reconciliation-source.js";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function txDetail(args: {
  err?: unknown;
  accountKeys?: string[];
  preSol?: number[];
  postSol?: number[];
  preToken?: Array<{ owner: string; amount: string }>;
  postToken?: Array<{ owner: string; amount: string }>;
}): Record<string, unknown> {
  return {
    meta: {
      err: args.err ?? null,
      preBalances: args.preSol ?? [],
      postBalances: args.postSol ?? [],
      preTokenBalances:
        args.preToken?.map((entry) => ({
          owner: entry.owner,
          uiTokenAmount: { amount: entry.amount },
        })) ?? null,
      postTokenBalances:
        args.postToken?.map((entry) => ({
          owner: entry.owner,
          uiTokenAmount: { amount: entry.amount },
        })) ?? null,
    },
    transaction: {
      message: { accountKeys: args.accountKeys ?? [WALLET] },
    },
  };
}

function rpcWith(
  entries: Array<{ signature: string; err: unknown | null }>,
  details: Record<string, Record<string, unknown> | null>,
): SolanaReconciliationRpc {
  return {
    async getSignaturesForAddress() {
      return entries;
    },
    async getTransaction(signature) {
      return details[signature] ?? null;
    },
  };
}

describe("solana devnet reconciliation source classification", () => {
  it("emits a positive native SOL delta to the enrolled wallet", async () => {
    const source = createSolanaDevnetReconciliationSource({
      rpc: rpcWith([{ signature: "sig-in", err: null }], {
        "sig-in": txDetail({ preSol: [100], postSol: [500] }),
      }),
    });
    const page = await source.fetchConfirmedPage({
      walletAddress: WALLET,
      network: "solana-devnet",
      caughtUpThrough: null,
      scanCursor: null,
      pageSize: 10,
    });
    expect(page.observations).toEqual([
      { signature: "sig-in", eventClass: "confirmed_transfer" },
    ]);
  });

  it("emits a positive SPL token delta attributed to the wallet owner", async () => {
    const source = createSolanaDevnetReconciliationSource({
      rpc: rpcWith([{ signature: "sig-spl", err: null }], {
        "sig-spl": txDetail({
          preSol: [50],
          postSol: [50],
          preToken: [{ owner: WALLET, amount: "0" }],
          postToken: [{ owner: WALLET, amount: "25" }],
        }),
      }),
    });
    const page = await source.fetchConfirmedPage({
      walletAddress: WALLET,
      network: "solana-devnet",
      caughtUpThrough: null,
      scanCursor: null,
      pageSize: 10,
    });
    expect(page.observations).toHaveLength(1);
    expect(page.observations[0]!.eventClass).toBe("confirmed_transfer");
  });

  it("ignores outgoing, failed, and unsupported transactions", async () => {
    const source = createSolanaDevnetReconciliationSource({
      rpc: rpcWith(
        [
          { signature: "sig-out", err: null },
          { signature: "sig-failed", err: "InsufficientFunds" },
          { signature: "sig-unrelated", err: null },
        ],
        {
          // Outgoing: negative SOL delta for the wallet.
          "sig-out": txDetail({ preSol: [500], postSol: [100] }),
          // Failed: err non-null regardless of balances.
          "sig-failed": txDetail({ preSol: [100], postSol: [500], err: "x" }),
          // Wallet not a participant.
          "sig-unrelated": txDetail({
            accountKeys: ["11111111111111111111111111111111"],
            preSol: [0],
            postSol: [100],
          }),
        },
      ),
    });
    const page = await source.fetchConfirmedPage({
      walletAddress: WALLET,
      network: "solana-devnet",
      caughtUpThrough: null,
      scanCursor: null,
      pageSize: 10,
    });
    expect(page.observations).toEqual([]);
  });

  it("rejects when transaction details are unavailable (no-skip cursor contract)", async () => {
    const source = createSolanaDevnetReconciliationSource({
      rpc: rpcWith([{ signature: "sig-nodetail", err: null }], {
        "sig-nodetail": null,
      }),
    });
    await expect(
      source.fetchConfirmedPage({
        walletAddress: WALLET,
        network: "solana-devnet",
        caughtUpThrough: null,
        scanCursor: null,
        pageSize: 10,
      }),
    ).rejects.toThrow(/details unavailable/);
  });

  it("returns newest-first RPC entries as oldest-first observations with the oldest cursor", async () => {
    const source = createSolanaDevnetReconciliationSource({
      rpc: rpcWith(
        [
          { signature: "sig-new", err: null },
          { signature: "sig-mid", err: null },
          { signature: "sig-old", err: null },
        ],
        {
          "sig-new": txDetail({ preSol: [0], postSol: [10] }),
          "sig-mid": txDetail({ preSol: [0], postSol: [20] }),
          "sig-old": txDetail({ preSol: [0], postSol: [30] }),
        },
      ),
    });
    const page = await source.fetchConfirmedPage({
      walletAddress: WALLET,
      network: "solana-devnet",
      caughtUpThrough: null,
      scanCursor: null,
      pageSize: 10,
    });
    // Oldest-first processing order...
    expect(page.observations.map((o) => o.signature)).toEqual([
      "sig-old",
      "sig-mid",
      "sig-new",
    ]);
    // Page boundaries feed the forward catch-up scan.
    expect(page.pageNewest).toBe("sig-new");
    expect(page.pageOldest).toBe("sig-old");
    expect(page.reachedWatermark).toBe(true);
  });
});
