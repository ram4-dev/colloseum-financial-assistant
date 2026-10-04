import { describe, expect, it } from "vitest";
import {
  evaluateGrant,
  type DelegatedGrantRecord,
} from "../../src/wallet/grants/engine.js";

const NOW = Date.parse("2026-10-03T22:00:00.000Z");
const VALID_SOLANA = "So11111111111111111111111111111111111111112";

function grantFor(chain: string, recipients: string[]): DelegatedGrantRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    userId: "55555555-5555-4555-8555-555555555555",
    walletId: "66666666-6666-4666-8666-666666666666",
    action: "transfer",
    chain,
    maxPerTransfer: "1000",
    maxCumulative: "5000",
    windowSeconds: 3600,
    recipients,
    state: "active",
    providerPolicyId: "fixture_policy_validators",
    createdAt: NOW - 60_000,
    expiresAt: NOW + 86_400_000,
    revokedAt: null,
  };
}

describe("chain validator plug-in (DGC-2.2)", () => {
  it("accepts a valid base58 solana recipient", () => {
    const decision = evaluateGrant(
      grantFor("solana", [VALID_SOLANA]),
      {
        action: "transfer",
        chain: "solana",
        amount: "100",
        recipient: VALID_SOLANA,
        now: NOW,
      },
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({ decision: "covered" });
  });

  it("rejects base58 lookalikes (0, O, I, l) as malformed", () => {
    for (const bad of ["0OIl", "l0OIl", "0xdeadbeef"]) {
      const decision = evaluateGrant(
        grantFor("solana", [bad]),
        {
          action: "transfer",
          chain: "solana",
          amount: "100",
          recipient: bad,
          now: NOW,
        },
        { consumedInWindow: "0" },
      );
      expect(decision).toEqual({
        decision: "degrade",
        reason: "recipient_invalid",
      });
    }
  });

  it("fails closed for an unregistered chain before any allowlist logic", () => {
    const decision = evaluateGrant(
      grantFor("ethereum", ["0xabc"]),
      {
        action: "transfer",
        chain: "ethereum",
        amount: "100",
        recipient: "0xabc",
        now: NOW,
      },
      { consumedInWindow: "0" },
    );
    expect(decision).toEqual({
      decision: "degrade",
      reason: "validator_unavailable",
    });
  });
});
