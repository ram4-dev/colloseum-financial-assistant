import { describe, expect, it } from "vitest";
import {
  classifyGrantCoverage,
  type CoverageCandidateGrant,
  type CoverageRequest,
} from "../../src/conversations/grant-coverage.js";

/**
 * Phase 1 RED (slice3-grant-execution): unit contract for the pure
 * `classifyGrantCoverage` pre-filter proposed by design AD-2/AD-4/AD-5.
 *
 * Contract under test (does not exist yet — honest RED):
 * - Input: `request` (original-request-bound intent: exact human `amount`,
 *   `recipient`, `token`, `network`, `chain`, `now` = original request turn
 *   timestamp). Two SERVER-OWNED fields drive eligibility and are never
 *   inferred from payload presence: `origin` ("user_request" | "model_tool",
 *   a server-side discriminator from the preview entry point, never tool
 *   payload) and `intentBoundToOriginalText` (an explicit required boolean,
 *   computed by the server from the authenticated original text/transcript;
 *   anything other than `true` — missing, false, or derived from origin —
 *   makes the request ineligible). `candidates` (user's active grants as
 *   ledger rows) and `tokenDecimals` lookup for fail-closed conversion.
 * - Output: ordered decision —
 *   `{ outcome: "covered", grantId, amountSmallestUnits }` when exactly the
 *   deterministic least-privilege candidate covers, or
 *   `{ outcome: "degrade", reason }` otherwise. `reason` is internal-only
 *   (never surfaced in HTTP per Q4).
 *
 * Structural invariant (AD-2): the module must not accept any database
 * client, consumption reader, or window total — the signature below has no
 * parameter for one. 1.5's structural test is satisfied by construction.
 */

const NOW = Date.parse("2026-10-03T22:00:00.000Z");
const RECIPIENT_OK = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const RECIPIENT_OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";

function grant(
  overrides: Partial<CoverageCandidateGrant> = {},
): CoverageCandidateGrant {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    walletId: "33333333-3333-4333-8333-333333333333",
    action: "transfer",
    chain: "solana",
    maxPerTransfer: "10000000",
    maxCumulative: "50000000",
    recipients: [RECIPIENT_OK],
    state: "active",
    providerPolicyId: "policy_fixture",
    createdAt: NOW - 60_000,
    expiresAt: NOW + 7 * 86_400_000,
    ...overrides,
  };
}

function request(overrides: Partial<CoverageRequest> = {}): CoverageRequest {
  return {
    origin: "user_request",
    action: "transfer",
    chain: "solana",
    network: "solana-devnet",
    token: "SOL",
    amount: "0.01",
    recipient: RECIPIENT_OK,
    walletId: "33333333-3333-4333-8333-333333333333",
    now: NOW,
    intentBoundToOriginalText: true,
    ...overrides,
  };
}

function decimals(network: string, token: string): number | null {
  if (network === "solana-devnet" && token === "SOL") return 9;
  return null;
}

describe("classifyGrantCoverage (phase 1 RED)", () => {
  it("converts SOL 0.01 to exactly 10000000 lamports and covers at the exact ceiling", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toMatchObject({
      outcome: "covered",
      grantId: "11111111-1111-4111-8111-111111111111",
      amountSmallestUnits: "10000000",
    });
  });

  it("degrades when the converted amount is one lamport above the per-transfer cap", () => {
    const decision = classifyGrantCoverage({
      request: request({ amount: "0.010000001" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({
      outcome: "degrade",
      reason: "per_transfer_cap_exceeded",
    });
  });

  it("degrades closed when intent binding is false (server-computed, explicit)", () => {
    const decision = classifyGrantCoverage({
      request: request({ intentBoundToOriginalText: false }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({
      outcome: "degrade",
      reason: "intent_not_bound",
    });
  });

  it("degrades closed when intent binding is missing — never inferred from origin or fields", () => {
    const missing = { ...request() } as Record<string, unknown>;
    delete missing.intentBoundToOriginalText;
    const decision = classifyGrantCoverage({
      request: missing as unknown as CoverageRequest,
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({
      outcome: "degrade",
      reason: "intent_not_bound",
    });
  });

  it("degrades closed when the amount or recipient is ambiguous in the original text", () => {
    const ambiguous = classifyGrantCoverage({
      request: request({ intentAmbiguous: true }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(ambiguous).toEqual({
      outcome: "degrade",
      reason: "intent_not_bound",
    });
  });

  it("denies coverage for model/tool-origin previews regardless of grant state", () => {
    const decision = classifyGrantCoverage({
      request: request({ origin: "model_tool" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({
      outcome: "degrade",
      reason: "origin_ineligible",
    });
  });

  it("denies coverage for an unknown origin value (server-owned discriminator)", () => {
    const decision = classifyGrantCoverage({
      request: request({ origin: "attacker_supplied" as "user_request" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({
      outcome: "degrade",
      reason: "origin_ineligible",
    });
  });

  it("degrades closed on unknown token / missing decimals factor", () => {
    const decision = classifyGrantCoverage({
      request: request({ token: "NOPE" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "units_unknown" });
  });

  it("degrades closed on a non-integral human amount (more fractional digits than decimals)", () => {
    const decision = classifyGrantCoverage({
      request: request({ amount: "0.01234567890" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({
      outcome: "degrade",
      reason: "units_non_integral",
    });
  });

  it("picks the least-privilege candidate: lowest per-transfer cap first", () => {
    const broad = grant({
      id: "22222222-2222-4222-8222-222222222222",
      maxPerTransfer: "50000000",
      maxCumulative: "50000000",
    });
    const narrow = grant();
    const decision = classifyGrantCoverage({
      request: request({ amount: "0.005" }),
      candidates: [broad, narrow],
      tokenDecimals: decimals,
    });
    expect(decision).toMatchObject({
      outcome: "covered",
      grantId: narrow.id,
      amountSmallestUnits: "5000000",
    });
  });

  it("breaks ties on cumulative cap when per-transfer caps are equal", () => {
    const samePerTransfer = (id: string, maxCumulative: string) =>
      grant({ id, maxPerTransfer: "10000000", maxCumulative });
    const narrowCumulative = samePerTransfer(
      "33333331-1111-4111-8111-111111111111",
      "20000000",
    );
    const broadCumulative = samePerTransfer(
      "33333332-1111-4111-8111-111111111111",
      "50000000",
    );
    const decision = classifyGrantCoverage({
      request: request({ amount: "0.001" }),
      candidates: [broadCumulative, narrowCumulative],
      tokenDecimals: decimals,
    });
    expect(decision).toMatchObject({
      outcome: "covered",
      grantId: narrowCumulative.id,
    });
  });

  it("breaks ties deterministically: expiry, then stable id", () => {
    const sameCaps = (id: string, expiresAt: number) =>
      grant({
        id,
        maxPerTransfer: "10000000",
        maxCumulative: "50000000",
        expiresAt,
      });
    const early = sameCaps(
      "aaaaaaa1-1111-4111-8111-111111111111",
      NOW + 86_400_000,
    );
    const late = sameCaps(
      "aaaaaaa2-1111-4111-8111-111111111111",
      NOW + 7 * 86_400_000,
    );
    const byExpiry = classifyGrantCoverage({
      request: request({ amount: "0.001" }),
      candidates: [late, early],
      tokenDecimals: decimals,
    });
    expect(byExpiry).toMatchObject({ outcome: "covered", grantId: early.id });

    const sameExpiry = NOW + 86_400_000;
    const b = sameCaps("bbbbbbb1-1111-4111-8111-111111111111", sameExpiry);
    const a = sameCaps("aaaaaaa9-1111-4111-8111-111111111111", sameExpiry);
    const byId = classifyGrantCoverage({
      request: request({ amount: "0.001" }),
      candidates: [b, a],
      tokenDecimals: decimals,
    });
    expect(byId).toMatchObject({ outcome: "covered", grantId: a.id });
  });

  it("degrades for a revoked candidate", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [grant({ state: "revoked" })],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "no_candidate" });
  });

  it("degrades for an expired candidate (expiry boundary inclusive: now === expiresAt)", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [grant({ expiresAt: NOW })],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "no_candidate" });
  });

  it("degrades when no candidate's allowlist matches the requested recipient", () => {
    const decision = classifyGrantCoverage({
      request: request({ recipient: RECIPIENT_OTHER }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "no_candidate" });
  });

  it("degrades on chain/action mismatch between request and grant", () => {
    const chainMismatch = classifyGrantCoverage({
      request: request({ chain: "evm-sepolia" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(chainMismatch).toEqual({
      outcome: "degrade",
      reason: "no_candidate",
    });

    const actionMismatch = classifyGrantCoverage({
      request: request({ action: "swap" as "transfer" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(actionMismatch).toEqual({
      outcome: "degrade",
      reason: "no_candidate",
    });
  });

  it("degrades when the candidate lacks a provider policy binding (policy_not_ready)", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [grant({ providerPolicyId: null })],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({
      outcome: "degrade",
      reason: "policy_not_ready",
    });
  });

  it("degrades closed on a malformed (non-positive) amount without converting", () => {
    const decision = classifyGrantCoverage({
      request: request({ amount: "0" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "units_invalid" });
  });

  it("degrades closed when the decimals lookup returns null for the requested token", () => {
    const decision = classifyGrantCoverage({
      request: request({ token: "USDC" }),
      candidates: [grant()],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "units_unknown" });
  });

  it("does not let a policy-less stale grant block a valid ready sibling (policy_not_ready only when nothing else covers)", () => {
    const unbound = grant({ providerPolicyId: null });
    const ready = grant({
      id: "44444444-4444-4444-8444-444444444444",
      maxPerTransfer: "20000000",
      maxCumulative: "50000000",
    });
    const withSibling = classifyGrantCoverage({
      request: request({ amount: "0.01" }),
      candidates: [unbound, ready],
      tokenDecimals: decimals,
    });
    expect(withSibling).toMatchObject({
      outcome: "covered",
      grantId: ready.id,
      amountSmallestUnits: "10000000",
    });

    const alone = classifyGrantCoverage({
      request: request(),
      candidates: [unbound],
      tokenDecimals: decimals,
    });
    expect(alone).toEqual({ outcome: "degrade", reason: "policy_not_ready" });
  });

  it("fails closed on a malformed persisted cap string instead of throwing", () => {
    const overCap = classifyGrantCoverage({
      request: request(),
      candidates: [grant({ maxPerTransfer: "not-a-number" })],
      tokenDecimals: decimals,
    });
    expect(overCap).toEqual({ outcome: "degrade", reason: "no_candidate" });

    // BigInt alone would accept hex; the decimal-only contract must reject it.
    const hexCap = classifyGrantCoverage({
      request: request(),
      candidates: [grant({ maxPerTransfer: "0x12" })],
      tokenDecimals: decimals,
    });
    expect(hexCap).toEqual({ outcome: "degrade", reason: "no_candidate" });
  });

  it("drops a malformed maxCumulative row without affecting least-privilege selection", () => {
    const malformed = grant({ id: "55555555-5555-4555-8555-555555555555" });
    const malformedCumulative = {
      ...malformed,
      maxCumulative: "12x0",
    } as CoverageCandidateGrant;
    const narrow = grant();
    const broad = grant({
      id: "66666666-6666-4666-8666-666666666666",
      maxPerTransfer: "50000000",
      maxCumulative: "50000000",
    });
    const decision = classifyGrantCoverage({
      request: request({ amount: "0.005" }),
      candidates: [malformedCumulative, broad, narrow],
      tokenDecimals: decimals,
    });
    expect(decision).toMatchObject({
      outcome: "covered",
      grantId: narrow.id,
      amountSmallestUnits: "5000000",
    });

    // Hex-style cumulative caps are likewise invalid decimal strings.
    const hexCumulative = {
      ...malformed,
      maxCumulative: "0x12",
    } as CoverageCandidateGrant;
    const withHex = classifyGrantCoverage({
      request: request({ amount: "0.005" }),
      candidates: [hexCumulative, broad, narrow],
      tokenDecimals: decimals,
    });
    expect(withHex).toMatchObject({
      outcome: "covered",
      grantId: narrow.id,
      amountSmallestUnits: "5000000",
    });
  });

  it("fails closed when the tokenDecimals lookup throws instead of propagating", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [grant()],
      tokenDecimals: () => {
        throw new Error("registry down");
      },
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "units_unknown" });
  });

  it("excludes candidates whose wallet does not match the executing wallet (D-2)", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [grant({ walletId: "99999999-9999-4999-8999-999999999999" })],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "no_candidate" });
  });

  it("excludes candidates created after the original request turn (Q1 timestamp rule)", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [grant({ createdAt: NOW + 1_000 })],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "no_candidate" });
  });

  it("degrades closed when no candidate exists", () => {
    const decision = classifyGrantCoverage({
      request: request(),
      candidates: [],
      tokenDecimals: decimals,
    });
    expect(decision).toEqual({ outcome: "degrade", reason: "no_candidate" });
  });
});
