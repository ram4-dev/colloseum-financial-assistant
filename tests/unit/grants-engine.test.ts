import { describe, expect, it } from "vitest";
import {
  evaluateGrant,
  type DelegatedGrantRecord,
  type GrantExecutionRequest,
} from "../../src/wallet/grants/engine.js";

const NOW = Date.parse("2026-10-03T22:00:00.000Z");
const RECIPIENT_OK = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const RECIPIENT_OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";

function grant(overrides: Partial<DelegatedGrantRecord> = {}): DelegatedGrantRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    walletId: "33333333-3333-4333-8333-333333333333",
    action: "transfer",
    chain: "solana",
    maxPerTransfer: "1_000_000_000",
    maxCumulative: "5_000_000_000",
    windowSeconds: 86_400,
    recipients: [RECIPIENT_OK],
    state: "active",
    providerPolicyId: null,
    createdAt: NOW - 60_000,
    expiresAt: NOW + 7 * 86_400_000,
    revokedAt: null,
    ...overrides,
  };
}

function request(
  overrides: Partial<GrantExecutionRequest> = {},
): GrantExecutionRequest {
  return {
    action: "transfer",
    chain: "solana",
    amount: "500_000_000",
    recipient: RECIPIENT_OK,
    now: NOW,
    ...overrides,
  };
}

describe("evaluateGrant (DGC-2, pure grant engine)", () => {
  it("covers an execution within all bounds", () => {
    const decision = evaluateGrant(grant(), request(), { consumedInWindow: "0" });
    expect(decision).toEqual({ decision: "covered" });
  });

  it("rejects amount above per-transfer cap", () => {
    const decision = evaluateGrant(
      grant(),
      request({ amount: "1_000_000_001" }),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({
      decision: "degrade",
      reason: "per_transfer_cap_exceeded",
    });
  });

  it("rejects when cumulative cap would be exceeded within the window", () => {
    const decision = evaluateGrant(grant(), request(), {
      consumedInWindow: "4_500_000_001",
    });
    expect(decision).toEqual({
      decision: "degrade",
      reason: "cumulative_cap_exceeded",
    });
  });

  it("covers an execution that exactly exhausts the cumulative cap", () => {
    const decision = evaluateGrant(grant(), request(), {
      consumedInWindow: "4_500_000_000",
    });
    expect(decision).toEqual({ decision: "covered" });
  });

  it("rejects an expired grant", () => {
    const decision = evaluateGrant(
      grant({ expiresAt: NOW - 1 }),
      request(),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({ decision: "degrade", reason: "grant_expired" });
  });

  it("rejects a revoked grant", () => {
    const decision = evaluateGrant(
      grant({ state: "revoked", revokedAt: NOW - 1 }),
      request(),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({ decision: "degrade", reason: "grant_revoked" });
  });

  it("rejects a non-active state even if not explicitly revoked", () => {
    const decision = evaluateGrant(grant({ state: "expired" }), request(), {
      consumedInWindow: "0",
    });
    expect(decision).toEqual({ decision: "degrade", reason: "grant_revoked" });
  });

  it("rejects a recipient outside the allowlist", () => {
    const decision = evaluateGrant(
      grant(),
      request({ recipient: RECIPIENT_OTHER }),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({
      decision: "degrade",
      reason: "recipient_not_allowed",
    });
  });

  it("rejects when the allowlist is empty (no recipients authorized)", () => {
    const decision = evaluateGrant(grant({ recipients: [] }), request(), {
      consumedInWindow: "0",
    });
    expect(decision).toEqual({
      decision: "degrade",
      reason: "recipient_not_allowed",
    });
  });

  it("rejects an action the grant does not cover", () => {
    const decision = evaluateGrant(
      grant(),
      request({ action: "swap" }),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({
      decision: "degrade",
      reason: "action_not_covered",
    });
  });

  it("fails closed when the chain has no registered validator", () => {
    const decision = evaluateGrant(
      grant({ chain: "ethereum" }),
      request({ chain: "ethereum", recipient: "0xabc" }),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({
      decision: "degrade",
      reason: "validator_unavailable",
    });
  });

  it("fails closed when the chain validator rejects a malformed recipient", () => {
    const decision = evaluateGrant(
      grant(),
      request({ recipient: "not-base58!!" }),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({
      decision: "degrade",
      reason: "recipient_invalid",
    });
  });

  it("validates the grant chain matches the request chain", () => {
    const decision = evaluateGrant(
      grant({ chain: "solana" }),
      request({ chain: "ethereum" }),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({
      decision: "degrade",
      reason: "action_not_covered",
    });
  });

  it("covers a second execution when the window has rolled past old usage", () => {
    // Window accounting is temporal: the caller aggregates only usage inside the
    // window (see consumption.ts). This test pins the boundary contract: when the
    // caller reports usage from OUTSIDE the window as zero, the execution covers.
    const decision = evaluateGrant(
      grant({ windowSeconds: 3_600 }),
      request({ now: NOW }),
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({ decision: "covered" });
  });
});
