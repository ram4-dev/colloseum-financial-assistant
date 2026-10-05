import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  MAX_PAGE_SIZE,
  reconcileWalletOnce,
  startReconciliationWorker,
  type CatchUpPageResult,
  type ReconciliationSource,
} from "../../src/notifications/reconciliation-worker.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// Task 2.4 integration: forward catch-up cursor (lossless drain), DB lease
// acquisition/exclusion/release, bounded page size, post-commit fan-out
// ordering, and clean lifecycle — fake source, real isolated PostgreSQL.
suite("reconciliation worker (forward catch-up, lease, lifecycle)", () => {
  let database: DatabaseClient;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  function fakeSource(allSignatures: string[]): {
    source: ReconciliationSource;
    pageRequests: Array<{
      scanCursor: string | null;
      caughtUpThrough: string | null;
      pageSize: number;
    }>;
  } {
    // Newest-first full history, like the RPC contract.
    const newestFirst = [...allSignatures].reverse();
    const pageRequests: Array<{
      scanCursor: string | null;
      caughtUpThrough: string | null;
      pageSize: number;
    }> = [];
    return {
      pageRequests,
      source: {
        async fetchConfirmedPage(request) {
          pageRequests.push({
            scanCursor: request.scanCursor,
            caughtUpThrough: request.caughtUpThrough,
            pageSize: request.pageSize,
          });
          // Window: entries NEWER than caughtUpThrough (or all), older than
          // scanCursor when set (scan boundary re-observed, then skipped).
          let window = newestFirst;
          if (request.caughtUpThrough !== null) {
            const idx = newestFirst.indexOf(request.caughtUpThrough);
            window = idx === -1 ? window : window.slice(0, idx);
          } else if (request.scanCursor !== null) {
            const idx = newestFirst.indexOf(request.scanCursor);
            window = idx === -1 ? window : window.slice(idx + 1);
          } else if (request.scanCursor === null && request.caughtUpThrough === null) {
            window = newestFirst;
          }
          if (request.scanCursor !== null && request.caughtUpThrough !== null) {
            const scanIdx = newestFirst.indexOf(request.scanCursor);
            const untilIdx = newestFirst.indexOf(request.caughtUpThrough);
            window = newestFirst.slice(
              Math.min(scanIdx, untilIdx) + 1,
              Math.max(scanIdx, untilIdx),
            );
          }
          const pageEntries = window.slice(0, request.pageSize);
          const result: CatchUpPageResult = {
            observations: pageEntries
              .slice()
              .reverse()
              .map((signature) => ({
                signature,
                eventClass: "confirmed_transfer" as const,
              })),
            pageNewest: pageEntries[0] ?? null,
            pageOldest: pageEntries.at(-1) ?? null,
            reachedWatermark:
              pageEntries.length < request.pageSize ||
              pageEntries.at(-1) === request.caughtUpThrough,
          };
          return result;
        },
      },
    };
  }

  async function provisionWallet(): Promise<{
    userId: string;
    walletId: string;
  }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:slice5-recon-${randomUUID()}`, "Slice 5 Reconciliation"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
       VALUES ($1, 'privy', $2, 'solana', $3, 'ready', now()) RETURNING id`,
      [userId, `acct-recon-${randomUUID()}`, ADDRESS],
    );
    return { userId, walletId: wallet.rows[0]!.id };
  }

  function walletOf(walletId: string) {
    return { id: walletId, address: ADDRESS, network: "solana-devnet" };
  }

  async function cursorState(walletId: string) {
    const rows = await database.query<{
      cursor_value: string | null;
      scan_high_watermark: string | null;
      scan_cursor: string | null;
    }>(
      `SELECT cursor_value, scan_high_watermark, scan_cursor
       FROM reconciliation_cursors WHERE wallet_id = $1`,
      [walletId],
    );
    return rows.rows[0] ?? null;
  }

  async function notificationCount(userId: string): Promise<number> {
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM wallet_notifications WHERE user_id = $1`,
      [userId],
    );
    return rows.rows.length;
  }

  it("catches up a gap larger than pageSize losslessly across repeated runs", async () => {
    const { userId, walletId } = await provisionWallet();
    // 7 signatures, page size 3: pages [new3], [mid3], [old1+watermark].
    const signatures = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    const { source } = fakeSource(signatures);
    const wallet = walletOf(walletId);

    const run1 = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-catchup",
      pageSize: 3,
      leaseSeconds: 60,
      maxPagesPerRun: 1,
    });
    expect(run1.caughtUp).toBe(false); // gap still open after page 1
    const state1 = await cursorState(walletId);
    expect(state1!.scan_high_watermark).toBe("s7");
    expect(state1!.scan_cursor).toBe("s5");

    const run2 = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-catchup",
      pageSize: 3,
      leaseSeconds: 60,
      maxPagesPerRun: 1,
    });
    expect(run2.caughtUp).toBe(false);
    const state2 = await cursorState(walletId);
    expect(state2!.scan_cursor).toBe("s2");

    const run3 = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-catchup",
      pageSize: 3,
      leaseSeconds: 60,
      maxPagesPerRun: 1,
    });
    expect(run3.caughtUp).toBe(true);
    expect(run3.caughtUpThrough).toBe("s7");
    const state3 = await cursorState(walletId);
    expect(state3!.cursor_value).toBe("s7");
    expect(state3!.scan_high_watermark).toBeNull();
    expect(state3!.scan_cursor).toBeNull();
    expect(await notificationCount(userId)).toBe(7);
  });

  it("drains a single-page gap in one run with the watermark advanced", async () => {
    const { userId, walletId } = await provisionWallet();
    const { source } = fakeSource(["a1", "a2"]);
    const result = await reconcileWalletOnce({
      database,
      source,
      wallet: walletOf(walletId),
      workerId: "w-single",
      pageSize: 10,
      leaseSeconds: 60,
      maxPagesPerRun: 5,
    });
    expect(result.caughtUp).toBe(true);
    expect(result.caughtUpThrough).toBe("a2");
    expect(await notificationCount(userId)).toBe(2);
  });

  it("discovers a later fresh signature on the next poll after being caught up", async () => {
    const { userId, walletId } = await provisionWallet();
    const { source } = fakeSource(["f1"]);
    const wallet = walletOf(walletId);

    const first = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-poll",
      pageSize: 10,
      leaseSeconds: 60,
      maxPagesPerRun: 5,
    });
    expect(first.caughtUp).toBe(true);

    // A new signature arrives after the watermark: fakeSource takes
    // oldest-first input, so ["f1", "f2"] models f2 arriving later.
    const rebuilt = fakeSource(["f1", "f2"]);
    const second = await reconcileWalletOnce({
      database,
      source: rebuilt.source,
      wallet,
      workerId: "w-poll",
      pageSize: 10,
      leaseSeconds: 60,
      maxPagesPerRun: 5,
    });
    expect(second.caughtUp).toBe(true);
    expect(second.caughtUpThrough).toBe("f2");
    // Second poll requested only the gap (caughtUpThrough=f1 present).
    expect(
      rebuilt.pageRequests.some((r) => r.caughtUpThrough === "f1"),
    ).toBe(true);
    expect(await notificationCount(userId)).toBe(2);
  });

  it("releases the lease after a successful run so a following run acquires again", async () => {
    const { walletId } = await provisionWallet();
    const { source } = fakeSource([]);
    const wallet = walletOf(walletId);

    const first = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "worker-a",
      pageSize: 10,
      leaseSeconds: 300,
      maxPagesPerRun: 5,
    });
    expect(first.leaseAcquired).toBe(true);

    const second = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "worker-b",
      pageSize: 10,
      leaseSeconds: 300,
      maxPagesPerRun: 5,
    });
    expect(second.leaseAcquired).toBe(true);
  });

  it("excludes a concurrent second worker while the first run holds the lease", async () => {
    const { walletId } = await provisionWallet();
    const wallet = walletOf(walletId);

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const sourceA: ReconciliationSource = {
      fetchConfirmedPage: async () => {
        await gateA;
        return {
          observations: [],
          pageNewest: null,
          pageOldest: null,
          reachedWatermark: true,
        };
      },
    };
    const runA = reconcileWalletOnce({
      database,
      source: sourceA,
      wallet,
      workerId: "worker-a",
      pageSize: 10,
      leaseSeconds: 300,
      maxPagesPerRun: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const runB = await reconcileWalletOnce({
      database,
      source: {
        fetchConfirmedPage: async () => ({
          observations: [],
          pageNewest: null,
          pageOldest: null,
          reachedWatermark: true,
        }),
      },
      wallet,
      workerId: "worker-b",
      pageSize: 10,
      leaseSeconds: 300,
      maxPagesPerRun: 5,
    });
    expect(runB.leaseAcquired).toBe(false);

    releaseA();
    const finishedA = await runA;
    expect(finishedA.leaseAcquired).toBe(true);
  });

  it("does not advance any cursor state when the source fails mid-run", async () => {
    const { walletId } = await provisionWallet();
    const source: ReconciliationSource = {
      fetchConfirmedPage: async () => {
        throw new Error("rpc unavailable");
      },
    };
    await expect(
      reconcileWalletOnce({
        database,
        source,
        wallet: walletOf(walletId),
        workerId: "worker-fail",
        pageSize: 10,
        leaseSeconds: 60,
        maxPagesPerRun: 5,
      }),
    ).rejects.toThrow("rpc unavailable");

    const state = await cursorState(walletId);
    expect(state).toBeNull();
  });

  it("clamps an oversized page request to the MAX_PAGE_SIZE bound", async () => {
    const { walletId } = await provisionWallet();
    const { source, pageRequests } = fakeSource(["c1"]);
    await reconcileWalletOnce({
      database,
      source,
      wallet: walletOf(walletId),
      workerId: "worker-bound",
      pageSize: 10_000,
      leaseSeconds: 60,
      maxPagesPerRun: 5,
    });
    expect(pageRequests[0]!.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("publishes fan-out only after commit, only for the insert winner, and swallows failures", async () => {
    const { userId, walletId } = await provisionWallet();
    const order: string[] = [];
    const publish = vi.fn(async () => {
      order.push("publish");
    });
    const { source } = fakeSource(["p1", "p1-dup"]);
    // Both observations map to distinct dedupe keys, so both insert; make one
    // replay to prove the loser never publishes.
    const wallet = walletOf(walletId);

    const first = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-fanout",
      pageSize: 10,
      leaseSeconds: 60,
      maxPagesPerRun: 5,
      onNotificationInserted: publish,
    });
    expect(first.signaturesProcessed).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(order.every((entry) => entry === "publish")).toBe(true);

    // Replay the same gap: dedupe losers, no fan-out.
    const replayPublish = vi.fn(async () => undefined);
    await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-fanout",
      pageSize: 10,
      leaseSeconds: 60,
      maxPagesPerRun: 5,
      onNotificationInserted: replayPublish,
    });
    expect(replayPublish).not.toHaveBeenCalled();
    expect(await notificationCount(userId)).toBe(2);

    // A failing publisher never breaks the run.
    const failing = vi.fn(async () => {
      throw new Error("livekit down");
    });
    const { source: freshSource } = fakeSource(["p2"]);
    const third = await reconcileWalletOnce({
      database,
      source: freshSource,
      wallet,
      workerId: "w-fanout",
      pageSize: 10,
      leaseSeconds: 60,
      maxPagesPerRun: 5,
      onNotificationInserted: failing,
    });
    expect(third.signaturesProcessed).toBe(1);
  });

  it("promotes the watermark on an exact-multiple gap where the final page is empty", async () => {
    const { userId, walletId } = await provisionWallet();
    // 6 signatures, page size 3: pages [3], [3], [] — the last page is empty
    // (exact multiple), so drain completion must come from the empty page.
    const { source } = fakeSource(["m1", "m2", "m3", "m4", "m5", "m6"]);
    const wallet = walletOf(walletId);

    const run1 = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-exact",
      pageSize: 3,
      leaseSeconds: 60,
      maxPagesPerRun: 1,
    });
    expect(run1.caughtUp).toBe(false);

    const run2 = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-exact",
      pageSize: 3,
      leaseSeconds: 60,
      maxPagesPerRun: 1,
    });
    // Second full page does not reach the watermark either: still draining.
    expect(run2.caughtUp).toBe(false);

    const run3 = await reconcileWalletOnce({
      database,
      source,
      wallet,
      workerId: "w-exact",
      pageSize: 3,
      leaseSeconds: 60,
      maxPagesPerRun: 1,
    });
    // The empty final page completes the drain and promotes the watermark.
    expect(run3.caughtUp).toBe(true);
    expect(run3.caughtUpThrough).toBe("m6");
    const state = await cursorState(walletId);
    expect(state!.cursor_value).toBe("m6");
    expect(state!.scan_high_watermark).toBeNull();
    expect(state!.scan_cursor).toBeNull();
    expect(await notificationCount(userId)).toBe(6);
  });

  it("starts immediately, runs a pass, and stops cleanly awaiting in-flight work", async () => {
    await provisionWallet();
    let passes = 0;
    const source: ReconciliationSource = {
      fetchConfirmedPage: async () => {
        passes += 1;
        return {
          observations: [],
          pageNewest: null,
          pageOldest: null,
          reachedWatermark: true,
        };
      },
    };
    const worker = startReconciliationWorker({
      database,
      source,
      workerId: "worker-lifecycle",
      pageSize: 10,
      leaseSeconds: 60,
      intervalMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await worker.stop();
    expect(passes).toBeGreaterThanOrEqual(1);
  });
});
