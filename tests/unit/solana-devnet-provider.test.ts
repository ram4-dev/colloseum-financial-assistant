import { describe, expect, it, vi } from "vitest";
import { Transaction } from "@solana/web3.js";
import {
  SolanaDevnetProvider,
  buildDevnetSolTransfer,
  SOLANA_DEVNET_NETWORK,
  SOLANA_DEVNET_CAIP2,
  type SolanaRpc,
  type SolanaSignAndSendClient,
} from "../../src/wallet/solana-devnet-provider.js";
import { explorerUrlFor } from "../../src/wallet/provider.js";

const WALLET_ID = "wallet-1";
const CONTEXT = { wallet: WALLET_ID, network: SOLANA_DEVNET_NETWORK };
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SENDER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
const SIGNATURE =
  "5ZzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWMAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const REQUEST = {
  ...CONTEXT,
  token: "SOL",
  to: RECIPIENT,
  amount: "0.5",
  previewId: "preview-1",
};

function rpcDouble(overrides: Partial<SolanaRpc> = {}): SolanaRpc {
  return {
    getBalance: vi.fn().mockResolvedValue(2_000_000_000n),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue([{ confirmationStatus: "finalized", err: null }]),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    getRecentBlockhash: vi
      .fn()
      .mockResolvedValue("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq"),
    getFeeForTransferMessage: vi.fn().mockResolvedValue(5_000n),
    ...overrides,
  };
}

function signerDouble(
  overrides: Partial<SolanaSignAndSendClient> = {},
): SolanaSignAndSendClient {
  return {
    signAndSend: vi
      .fn()
      .mockResolvedValue({ hash: SIGNATURE, id: "privy-tx-1" }),
    ...overrides,
  } as SolanaSignAndSendClient;
}

function provider(
  rpc: SolanaRpc = rpcDouble(),
  signAndSend: SolanaSignAndSendClient = signerDouble(),
): SolanaDevnetProvider {
  return new SolanaDevnetProvider(
    { walletId: WALLET_ID, senderAddress: SENDER },
    {
      rpc,
      signAndSend,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
    },
  );
}

describe("SolanaDevnetProvider", () => {
  it("satisfies the normalized provider contract on devnet", async () => {
    const p = provider();
    await expect(p.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(p.listNetworks()).resolves.toEqual([
      { network: SOLANA_DEVNET_NETWORK, kind: "testnet" },
    ]);
    await expect(p.listTokens(SOLANA_DEVNET_NETWORK)).resolves.toEqual([
      { network: SOLANA_DEVNET_NETWORK, token: "SOL", decimals: 9 },
    ]);
    await expect(p.getAddress(CONTEXT)).resolves.toEqual({
      network: SOLANA_DEVNET_NETWORK,
      address: SENDER,
    });
    await expect(
      p.getBalance({ ...CONTEXT, token: "SOL" }),
    ).resolves.toMatchObject({
      network: SOLANA_DEVNET_NETWORK,
      token: "SOL",
      address: SENDER,
      balance: "2",
    });
    await expect(p.getHistory(CONTEXT)).resolves.toEqual({
      network: SOLANA_DEVNET_NETWORK,
      transactions: [],
    });
    const preview = await p.previewTransfer(REQUEST);
    expect(preview).toMatchObject({
      network: SOLANA_DEVNET_NETWORK,
      token: "SOL",
      recipient: RECIPIENT,
      amount: "0.5",
    });
    const broadcast = await p.broadcastTransfer(REQUEST);
    expect(broadcast.kind).toBe("submitted");
    if (broadcast.kind === "submitted") {
      await expect(
        p.waitForFinality(broadcast.transaction),
      ).resolves.toMatchObject({
        status: "confirmed",
        transactionHash: SIGNATURE,
      });
    }
    await p.close();
  });

  it("refuses every non-devnet network before any RPC or signer call", async () => {
    const rpc = rpcDouble();
    const signAndSend = signerDouble();
    const p = provider(rpc, signAndSend);
    for (const network of [
      "solana-mainnet",
      "solana",
      "sepolia",
      "arc-testnet",
    ]) {
      const context = { wallet: WALLET_ID, network };
      await expect(
        p.health(context as never).then(
          () => null,
          (e: unknown) => (e as Error).message,
        ),
      ).resolves.toContain("solana-devnet");
      await expect(p.listTokens(network)).rejects.toThrow(/solana-devnet/);
      await expect(p.getAddress(context)).rejects.toThrow(/solana-devnet/);
      await expect(p.getBalance({ ...context, token: "SOL" })).rejects.toThrow(
        /solana-devnet/,
      );
      await expect(p.getHistory(context)).rejects.toThrow(/solana-devnet/);
      await expect(p.previewTransfer({ ...REQUEST, network })).rejects.toThrow(
        /solana-devnet/,
      );
      await expect(
        p.broadcastTransfer({ ...REQUEST, network }),
      ).rejects.toThrow(/solana-devnet/);
    }
    expect(rpc.getBalance).not.toHaveBeenCalled();
    expect(signAndSend.signAndSend).not.toHaveBeenCalled();
  });

  it("refuses invalid recipients on preview and broadcast", async () => {
    const p = provider();
    await expect(
      p.previewTransfer({ ...REQUEST, to: "not-base58!!" }),
    ).rejects.toThrow();
    await expect(
      p.previewTransfer({ ...REQUEST, to: "11111111111111111111111111111111" }),
    ).rejects.toThrow();
    await expect(
      p.previewTransfer({ ...REQUEST, to: SENDER }),
    ).rejects.toThrow();
    await expect(
      p.broadcastTransfer({ ...REQUEST, to: "not-base58!!" }),
    ).rejects.toThrow();
  });

  it("maps broadcast outcomes honestly", async () => {
    const notDispatched = provider(
      rpcDouble(),
      signerDouble({
        signAndSend: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("policy denied"), { definitive: true }),
          ),
      }),
    );
    await expect(
      notDispatched.broadcastTransfer(REQUEST),
    ).resolves.toMatchObject({
      kind: "not_dispatched",
    });

    const uncertain = provider(
      rpcDouble(),
      signerDouble({
        signAndSend: vi
          .fn()
          .mockRejectedValue(new Error("timeout after leaving our process")),
      }),
    );
    const outcome = await uncertain.broadcastTransfer(REQUEST);
    expect(outcome.kind).toBe("uncertain");
    if (outcome.kind === "uncertain")
      expect(outcome.reason).toMatch(/reference/i);
  });

  it("reconciliation never re-dispatches: single dispatch, stable reference, stays uncertain", async () => {
    const signAndSend = signerDouble({
      signAndSend: vi
        .fn()
        .mockRejectedValue(new Error("timeout after leaving our process")),
    });
    const p = provider(rpcDouble(), signAndSend);
    const first = await p.broadcastTransfer(REQUEST);
    expect(first.kind).toBe("uncertain");
    const dispatchMock = signAndSend.signAndSend as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const calls = dispatchMock.mock.calls as Array<
      [string, string, string, string]
    >;
    expect(calls[0][3]).toBe("preview-1");
    expect(calls[0][3].length).toBeLessThanOrEqual(64);
    // Reconcile by reference only — no second dispatch; without an
    // authoritative reference lookup the outcome stays uncertain.
    const reconciled = await p.reconcileBroadcast(REQUEST);
    expect(reconciled.kind).toBe("uncertain");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches only via Privy signAndSendTransaction with auth signature and devnet caip2", async () => {
    const signAndSend = signerDouble();
    const p = provider(rpcDouble(), signAndSend);
    await p.broadcastTransfer(REQUEST);
    const dispatchMock = signAndSend.signAndSend as unknown as ReturnType<
      typeof vi.fn
    >;
    const [walletId, caip2, transaction, referenceId] = dispatchMock.mock
      .calls[0] as [string, string, string, string];
    expect(walletId).toBe(WALLET_ID);
    expect(caip2).toBe(SOLANA_DEVNET_CAIP2);
    expect(typeof transaction).toBe("string");
    expect(transaction.length).toBeGreaterThan(0);
    expect(referenceId).toBe("preview-1");
    const rpc = rpcDouble();
    expect(Object.keys(rpc)).not.toContain("sendTransaction");
  });

  it("polls finality: confirmed, reverted, cache-miss recovery, receipt_invalid, deadline, abort", async () => {
    const confirmed = provider(
      rpcDouble({
        getSignatureStatuses: vi
          .fn()
          .mockResolvedValue([{ confirmationStatus: "finalized", err: null }]),
      }),
    );
    const broadcast = await confirmed.broadcastTransfer(REQUEST);
    expect(broadcast.kind).toBe("submitted");
    if (broadcast.kind === "submitted") {
      await expect(
        confirmed.waitForFinality(broadcast.transaction),
      ).resolves.toMatchObject({
        status: "confirmed",
      });
    }

    const reverted = provider(
      rpcDouble({
        getSignatureStatuses: vi
          .fn()
          .mockResolvedValue([
            { confirmationStatus: "finalized", err: "AccountInUse" },
          ]),
      }),
    );
    const b2 = await reverted.broadcastTransfer(REQUEST);
    if (b2.kind === "submitted") {
      await expect(
        reverted.waitForFinality(b2.transaction),
      ).resolves.toMatchObject({
        status: "reverted",
      });
    }

    // Cache-miss (null status) + history present + meta err null -> confirmed.
    const historyHit = provider(
      rpcDouble({
        getSignatureStatuses: vi.fn().mockResolvedValue(null),
        getSignaturesForAddress: vi
          .fn()
          .mockResolvedValue([{ signature: SIGNATURE }]),
        getTransaction: vi
          .fn()
          .mockResolvedValue({ slot: 1, meta: { err: null } }),
      }),
    );
    const b3 = await historyHit.broadcastTransfer(REQUEST);
    if (b3.kind === "submitted") {
      await expect(
        historyHit.waitForFinality(b3.transaction),
      ).resolves.toMatchObject({
        status: "confirmed",
      });
    }

    // Exhausted history without the signature: proven absent -> receipt_invalid.
    const absent = provider(
      rpcDouble({
        getSignatureStatuses: vi.fn().mockResolvedValue(null),
        getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      }),
    );
    const b3a = await absent.broadcastTransfer(REQUEST);
    if (b3a.kind === "submitted") {
      await expect(
        absent.waitForFinality(b3a.transaction),
      ).resolves.toMatchObject({
        status: "receipt_invalid",
      });
    }

    let now = 0;
    const deadline = new SolanaDevnetProvider(
      { walletId: WALLET_ID, senderAddress: SENDER },
      {
        rpc: rpcDouble({
          // RPC success with no status entry: resolver returns null each poll,
          // forcing pure deadline timeout (exhausted=false).
          getSignatureStatuses: vi.fn().mockResolvedValue([]),
          getTransaction: vi.fn().mockResolvedValue(null),
        }),
        signAndSend: signerDouble(),
        sleep: vi.fn().mockImplementation(() => {
          now += 3_000;
        }),
        now: () => now,
      },
    );
    const b4 = await deadline.broadcastTransfer(REQUEST);
    if (b4.kind === "submitted") {
      await expect(deadline.waitForFinality(b4.transaction)).rejects.toThrow(
        /deadline/i,
      );
    }

    const controller = new AbortController();
    controller.abort();
    const aborted = provider(
      rpcDouble({
        getSignatureStatuses: vi
          .fn()
          .mockResolvedValue([{ confirmationStatus: "finalized", err: null }]),
      }),
    );
    const b5 = await aborted.broadcastTransfer(REQUEST);
    if (b5.kind === "submitted") {
      await expect(
        aborted.waitForFinality(b5.transaction, controller.signal),
      ).rejects.toThrow(/abort/i);
    }
  });

  it("registers the devnet explorer URL", async () => {
    expect(explorerUrlFor(SOLANA_DEVNET_NETWORK, SIGNATURE)).toBe(
      `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
    );
    const p = provider();
    const broadcast = await p.broadcastTransfer(REQUEST);
    if (broadcast.kind === "submitted") {
      expect(broadcast.transaction.explorerUrl).toBe(
        explorerUrlFor(SOLANA_DEVNET_NETWORK, SIGNATURE),
      );
    }
  });

  it("builds a legacy Transaction with exactly one SystemProgram.transfer and no ALT path", () => {
    const transaction = buildDevnetSolTransfer(
      SENDER,
      RECIPIENT,
      500_000_000n,
      "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
    );
    // Legacy class, not v0: the legacy Transaction type carries no
    // addressLookupTableAccounts, so no ALT path can even be expressed.
    expect(transaction).toBeInstanceOf(Transaction);
    // Exactly one instruction: the SystemProgram.transfer to the exact
    // recipient with the exact lamports.
    expect(transaction.instructions).toHaveLength(1);
    const instruction = transaction.instructions[0]!;
    expect(instruction.programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    expect(instruction.keys.map((k) => k.pubkey.toBase58())).toEqual([
      SENDER,
      RECIPIENT,
    ]);
    // The transfer data is the 12-byte SystemProgram.transfer layout:
    // u32 LE discriminator [2,0,0,0] + u64 little-endian lamports.
    const expectedData = Buffer.alloc(12);
    expectedData.set([2, 0, 0, 0], 0);
    expectedData.writeBigUInt64LE(500_000_000n, 4);
    expect(instruction.data.equals(expectedData)).toBe(true);
  });
});
