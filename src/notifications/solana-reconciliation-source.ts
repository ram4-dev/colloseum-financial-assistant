import { Connection, PublicKey } from "@solana/web3.js";
import {
  SOLANA_DEVNET_NETWORK,
  SOLANA_DEVNET_RPC_URL,
} from "../wallet/solana-devnet-provider.js";
import type {
  ChainEventObservation,
  CatchUpPageRequest,
  ReconciliationSource,
} from "./reconciliation-worker.js";

export type SolanaReconciliationRpc = {
  getSignaturesForAddress(
    address: string,
    options?: { before?: string; until?: string; limit?: number },
  ): Promise<
    Array<{ signature: string; err: unknown | null; slot?: number }>
  >;
  getTransaction(
    signature: string,
  ): Promise<Record<string, unknown> | null>;
};

type SolanaMeta = {
  err: unknown;
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: Array<{
    owner?: string;
    mint?: string;
    uiTokenAmount?: { amount?: string };
    amount?: string;
  }> | null;
  postTokenBalances?: Array<{
    owner?: string;
    mint?: string;
    uiTokenAmount?: { amount?: string };
    amount?: string;
  }> | null;
};

/**
 * Production reconciliation source over the existing Solana devnet RPC.
 *
 * Forward polling contract: Solana's getSignaturesForAddress walks backward
 * from the newest confirmed block and `before` paginates toward OLDER
 * history, so the persisted cursor is a forward high watermark and pages are
 * fetched with `until: caughtUpThrough` (exclusive-safe through dedupe) to
 * discover only NEWER events. A page shorter than the limit proves the gap
 * is drained; a full page means newer unknown signatures may exist and the
 * next run continues from the advanced watermark.
 *
 * Classification (SDD): only confirmed inbound activity with a positive
 * delta to the enrolled wallet is emitted — native SOL deltas and SPL token
 * deltas keyed by owner+mint (mints never net together). Failed, outgoing,
 * self, and unsupported transactions are filtered at the source; the worker
 * never infers identity from balance changes.
 *
 * No-skip recovery: getTransaction is REQUIRED. A successful signature whose
 * details are temporarily unavailable throws, leaving the watermark
 * unchanged so the backoff retry re-reads the page.
 */
export function createSolanaDevnetReconciliationSource(args: {
  rpc: SolanaReconciliationRpc;
}): ReconciliationSource {
  const { rpc } = args;

  function hasPositiveSolDelta(
    meta: SolanaMeta,
    walletIndex: number,
  ): boolean {
    if (walletIndex === -1) return false;
    const pre = meta.preBalances?.[walletIndex];
    const post = meta.postBalances?.[walletIndex];
    return pre !== undefined && post !== undefined && post > pre;
  }

  function hasPositiveSplDelta(
    meta: SolanaMeta,
    walletAddress: string,
  ): boolean {
    // Deltas keyed by owner+mint: different mints never net together; emit
    // only when some individual mint shows a positive delta.
    const tokenDeltas = new Map<string, bigint>();
    const keyFor = (mint: string | undefined, owner: string) =>
      `${mint ?? "unknown"}:${owner}`;
    for (const entry of meta.preTokenBalances ?? []) {
      if (entry.owner !== walletAddress) continue;
      const amount = entry.uiTokenAmount?.amount ?? entry.amount;
      if (amount !== undefined) {
        const key = keyFor(entry.mint, entry.owner);
        tokenDeltas.set(key, (tokenDeltas.get(key) ?? 0n) - BigInt(amount));
      }
    }
    for (const entry of meta.postTokenBalances ?? []) {
      if (entry.owner !== walletAddress) continue;
      const amount = entry.uiTokenAmount?.amount ?? entry.amount;
      if (amount !== undefined) {
        const key = keyFor(entry.mint, entry.owner);
        tokenDeltas.set(key, (tokenDeltas.get(key) ?? 0n) + BigInt(amount));
      }
    }
    for (const delta of tokenDeltas.values()) {
      if (delta > 0n) return true;
    }
    return false;
  }

  function isInboundPositiveDelta(
    detail: Record<string, unknown>,
    walletAddress: string,
  ): boolean {
    const meta = detail.meta as SolanaMeta | undefined;
    if (!meta || meta.err != null) return false;

    // RPC account keys may arrive as web3 PublicKey objects; normalize with
    // String() so base58 equality against the enrolled address holds.
    const accountKeys = (
      (detail.transaction as
        | { message?: { accountKeys?: Array<string | { toString(): string }> } }
        | undefined
      )?.message?.accountKeys ?? []).map((key) => String(key));
    const walletIndex = accountKeys.indexOf(walletAddress);

    if (hasPositiveSolDelta(meta, walletIndex)) return true;
    return hasPositiveSplDelta(meta, walletAddress);
  }

  return {
    async fetchConfirmedPage({
      walletAddress,
      caughtUpThrough,
      scanCursor,
      pageSize,
    }: CatchUpPageRequest) {
      // Forward catch-up fetch: newest-first entries. First page stops at the
      // watermark (`until`); continuation pages start one OLDER than the
      // recorded scan boundary (`before=scanCursor` implies exclusive past,
      // so re-observe the boundary signature for overlap-safe dedupe) and
      // still stop at the watermark.
      const entries = await rpc.getSignaturesForAddress(walletAddress, {
        before: scanCursor ?? undefined,
        until: caughtUpThrough ?? undefined,
        limit: pageSize,
      });

      const observations: ChainEventObservation[] = [];
      // Entries are newest-first; classify/process oldest-first so inserts
      // and page ordering stay chronologically stable.
      const orderedEntries = entries.slice().reverse();
      for (const entry of orderedEntries) {
        if (
          entry.signature === caughtUpThrough ||
          (scanCursor !== null && entry.signature === scanCursor)
        )
          continue; // watermark/scan boundary itself: already durable
        if (entry.err != null) continue; // failed transaction: never notify
        const detail = await rpc.getTransaction(entry.signature);
        if (!detail) {
          // Temporarily unavailable details: refuse to advance the watermark.
          throw new Error(
            `Transaction details unavailable for ${entry.signature}; cursor held for retry.`,
          );
        }
        if (isInboundPositiveDelta(detail, walletAddress)) {
          observations.push({
            signature: entry.signature,
            eventClass: "confirmed_transfer",
          });
        }
      }

      return {
        observations,
        pageNewest: entries[0]?.signature ?? null,
        pageOldest: entries.at(-1)?.signature ?? null,
        // A page shorter than the limit reached the watermark (or history
        // start): nothing older remains within this gap.
        reachedWatermark: entries.length < pageSize,
      };
    },
  };
}

export const SOLANA_RECONCILIATION_NETWORK = SOLANA_DEVNET_NETWORK;

/**
 * Production wiring: a confirmed-commitment Connection over the canonical
 * devnet RPC endpoint, adapted into the worker's injectable source contract.
 */
export function createDefaultSolanaDevnetReconciliationSource(): ReconciliationSource {
  const connection = new Connection(SOLANA_DEVNET_RPC_URL, "confirmed");
  return createSolanaDevnetReconciliationSource({
    rpc: {
      async getSignaturesForAddress(address, options) {
        return connection.getSignaturesForAddress(new PublicKey(address), {
          before: options?.before,
          until: options?.until,
          limit: options?.limit,
        });
      },
      async getTransaction(signature) {
        const detail = await connection.getTransaction(signature, {
          commitment: "confirmed",
        });
        // SAFETY: web3.js TransactionResponse is a JSON-compatible superset of
        // the meta/accountKeys shape this source reads; no runtime mutation.
        return detail as unknown as Record<string, unknown> | null;
      },
    },
  });
}
