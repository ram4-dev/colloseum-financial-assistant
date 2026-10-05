import { describe, expect, it, vi } from "vitest";

import {
  computeReconciliationBackoff,
  nextCursorPage,
} from "../../../src/notifications/reconciliation.js";

describe("reconciliation cursor retry and ordering", () => {
  it("retries the first signature of an overlapped page before the cursor advances", async () => {
    // Page overlap contract: the reconciler re-reads the same page range until
    // every signature in it is durably processed, so a failure on the page's
    // FIRST signature must be retried before any cursor progress.
    const fetchPage = vi
      .fn<
        (
          cursor: string | null,
        ) => Promise<{ signatures: string[]; nextCursor: string }>
      >()
      .mockResolvedValue({
        signatures: ["sig-A", "sig-B"],
        nextCursor: "slot-100",
      });
    const processSignature = vi
      .fn<(signature: string) => Promise<void>>()
      // First attempt for the page's first signature fails (persistence error).
      .mockRejectedValueOnce(new Error("persistence failed"))
      .mockResolvedValue(undefined);

    const cursor = await nextCursorPage({
      initialCursor: null,
      fetchPage,
      processSignature,
      maxAttempts: 3,
    });

    // sig-A failed once and was retried; sig-B was only reached after sig-A
    // succeeded; the cursor advanced only after the whole page was durable.
    expect(processSignature.mock.calls.map(([s]) => s)).toEqual([
      "sig-A",
      "sig-A",
      "sig-B",
    ]);
    expect(cursor).toBe("slot-100");
  });

  it("never skips a failed event even when it is the last of a page", async () => {
    const fetchPage = vi
      .fn<
        (
          cursor: string | null,
        ) => Promise<{ signatures: string[]; nextCursor: string }>
      >()
      .mockResolvedValue({
        signatures: ["sig-1", "sig-2"],
        nextCursor: "slot-x",
      });
    const processSignature = vi
      .fn<(signature: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("persistence failed"))
      .mockResolvedValue(undefined);

    const cursor = await nextCursorPage({
      initialCursor: null,
      fetchPage,
      processSignature,
      maxAttempts: 3,
    });
    expect(processSignature.mock.calls.map(([s]) => s)).toEqual([
      "sig-1",
      "sig-2",
      "sig-2",
    ]);
    expect(cursor).toBe("slot-x");
  });

  it("keeps signature order stable within a page (oldest-first processing)", async () => {
    const order: string[] = [];
    await nextCursorPage({
      initialCursor: null,
      fetchPage: async () => ({
        signatures: ["sig-1", "sig-2", "sig-3"],
        nextCursor: "slot-x",
      }),
      processSignature: async (signature: string) => {
        order.push(signature);
      },
      maxAttempts: 2,
    });
    expect(order).toEqual(["sig-1", "sig-2", "sig-3"]);
  });
});

describe("worker exclusion and backoff", () => {
  it("computes capped exponential backoff with jitter bounds", () => {
    const base = computeReconciliationBackoff({
      attempt: 1,
      baseSeconds: 5,
      maxSeconds: 60,
    });
    const later = computeReconciliationBackoff({
      attempt: 10,
      baseSeconds: 5,
      maxSeconds: 60,
    });
    expect(base).toBeGreaterThanOrEqual(5);
    expect(base).toBeLessThanOrEqual(10); // base * 2^0 with bounded jitter
    expect(later).toBeLessThanOrEqual(60); // capped at maxSeconds
  });
});
