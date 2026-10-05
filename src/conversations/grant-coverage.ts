/**
 * slice3-grant-execution — Phase 2 GREEN (design AD-2/AD-4/AD-5).
 *
 * Pure grant-coverage pre-filter for the conversation execution boundary.
 *
 * Structural invariant (AD-2): this module NEVER reads consumption. Its
 * signature accepts no database client, no consumption reader, and no window
 * total; the cumulative rolling window is decided exclusively by the atomic
 * ledger claim (`DelegatedGrantService.claimConsumption`) at execution time.
 *
 * Eligibility is server-owned (AD-3): `origin` is a server-side discriminator
 * from the preview entry point (never tool payload), and
 * `intentBoundToOriginalText` is an explicit server-computed boolean derived
 * only from the authenticated original user turn/transcript. The classifier
 * never infers either from field presence; anything other than the exact
 * eligible values degrades closed.
 *
 * Intent binding (AD-2): `intentAmbiguous` is the server's verdict that the
 * original text does not bind an exact amount and resolved recipient. The
 * classifier never fills or overrides those fields from tool arguments.
 *
 * Units (AD-5): the human decimal string is converted with string/BigInt math
 * only through an injected decimals lookup; unknown token, missing decimals,
 * a non-integral fractional part, or a non-positive amount degrade closed
 * without rounding or truncation.
 *
 * Numeric amounts are decimal strings in SMALLEST UNITS (lamports for native
 * SOL). No floats anywhere.
 */

export type CoverageOrigin = "user_request" | "model_tool";

export type CoverageRequest = {
  /** Server-owned discriminator from the preview entry point, never tool payload. */
  origin: CoverageOrigin;
  action: "transfer";
  chain: string;
  network: string;
  token: string;
  /** Human-readable amount as bound to the authenticated original text. */
  amount: string;
  recipient: string;
  /** Server-resolved executing wallet identity (D-2). Required. */
  walletId: string;
  /** Original request turn timestamp (epoch ms). */
  now: number;
  /**
   * Explicit server-computed boolean: the exact amount and resolved recipient
   * were bound to the authenticated original user turn/transcript. Required:
   * anything other than `true` degrades closed. Never inferred from origin
   * or from field presence.
   */
  intentBoundToOriginalText: boolean;
  /** Server verdict that the original text left amount/recipient ambiguous. */
  intentAmbiguous?: boolean;
};

export type CoverageCandidateGrant = {
  id: string;
  walletId: string;
  action: "transfer";
  chain: string;
  /** Smallest-unit decimal string. */
  maxPerTransfer: string;
  /** Smallest-unit decimal string. */
  maxCumulative: string;
  recipients: string[];
  state: "active" | "revoked" | "expired";
  providerPolicyId: string | null;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  expiresAt: number;
};

/** Returns the token's decimals factor, or null when unknown (fail closed). */
export type TokenDecimalsLookup = (
  network: string,
  token: string,
) => number | null;

export type CoverageDecision =
  | { outcome: "covered"; grantId: string; amountSmallestUnits: string }
  | { outcome: "degrade"; reason: CoverageDegradeReason };

export type CoverageDegradeReason =
  | "origin_ineligible"
  | "intent_not_bound"
  | "units_unknown"
  | "units_non_integral"
  | "units_invalid"
  | "per_transfer_cap_exceeded"
  | "policy_not_ready"
  | "no_candidate";

function splitDecimal(
  amount: string,
): { whole: string; fraction: string; negative: boolean } | null {
  const trimmed = amount.trim();
  if (trimmed.length === 0) return null;
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const parts = unsigned.split(".");
  if (parts.length > 2) return null;
  const [whole, fraction = ""] = parts;
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  if (whole.length === 0 && fraction.length === 0) return null;
  return { whole, fraction, negative };
}

/**
 * Convert a human decimal amount to an integer smallest-unit decimal string.
 * Returns null when the amount is malformed, non-positive, has more
 * fractional digits than the token's decimals, or decimals is null/unknown.
 */
export function convertHumanAmount(
  amount: string,
  decimals: number | null,
): string | null {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0) {
    return null;
  }
  const parsed = splitDecimal(amount);
  if (!parsed) return null;
  const { whole, fraction, negative } = parsed;
  if (negative) return null;
  if (fraction.length > decimals) return null;
  const digits = `${whole}${fraction.padEnd(decimals, "0")}`;
  const value = BigInt(digits === "" ? "0" : digits);
  if (value <= 0n) return null;
  return value.toString();
}

function parseCap(value: string): bigint | null {
  // Integer-decimal storage contract: only plain digit strings are accepted.
  // BigInt alone would also accept hex ("0x12"), octal, and exponent forms.
  if (!/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed >= 0n ? parsed : null;
}

function compareAmounts(amount: bigint, cap: bigint): number {
  if (amount < cap) return -1;
  if (amount > cap) return 1;
  return 0;
}

/**
 * Deterministic least-privilege ordering (Q3): lowest per-transfer cap,
 * then lowest cumulative cap, then earliest expiry, then stable grant id.
 * Only well-formed candidates reach this comparator — malformed cap rows are
 * filtered out before sorting, so the comparator is a strict total order.
 */
function compareCandidates(
  a: CoverageCandidateGrant,
  b: CoverageCandidateGrant,
): number {
  const perTransfer = compareAmounts(BigInt(a.maxPerTransfer), BigInt(b.maxPerTransfer));
  if (perTransfer !== 0) return perTransfer;
  const cumulative = compareAmounts(BigInt(a.maxCumulative), BigInt(b.maxCumulative));
  if (cumulative !== 0) return cumulative;
  if (a.expiresAt !== b.expiresAt) return a.expiresAt < b.expiresAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}


/**
 * Classify grant coverage for the original transfer request. Static bounds
 * only: the cumulative rolling window is intentionally absent (AD-2) and is
 * enforced atomically by the ledger claim before any broadcast.
 */
export function classifyGrantCoverage(input: {
  request: CoverageRequest;
  candidates: CoverageCandidateGrant[];
  tokenDecimals: TokenDecimalsLookup;
}): CoverageDecision {
  const { request, candidates, tokenDecimals } = input;

  // Server-owned eligibility, checked before anything else (AD-3). Neither
  // field is ever inferred: unknown origins and any intent-binding value
  // other than the exact literal `true` degrade closed.
  if (request.origin !== "user_request") {
    return { outcome: "degrade", reason: "origin_ineligible" };
  }
  if (request.intentBoundToOriginalText !== true) {
    return { outcome: "degrade", reason: "intent_not_bound" };
  }
  if (request.intentAmbiguous === true) {
    return { outcome: "degrade", reason: "intent_not_bound" };
  }

  // Fail-closed units conversion (AD-5): no rounding, no truncation, no
  // clamping. The per-transfer ceiling acts only through coverage comparison.
  let decimals: number | null;
  try {
    decimals = tokenDecimals(request.network, request.token);
  } catch {
    // A failing registry lookup degrades closed; classification never throws.
    decimals = null;
  }
  if (decimals === null) {
    return { outcome: "degrade", reason: "units_unknown" };
  }
  const amount = convertHumanAmount(request.amount, decimals);
  if (amount === null) {
    // Distinguish a malformed/non-positive amount from a too-precise one.
    const parsed = splitDecimal(request.amount);
    if (parsed && parsed.fraction.length > decimals) {
      return { outcome: "degrade", reason: "units_non_integral" };
    }
    return { outcome: "degrade", reason: "units_invalid" };
  }

  return selectCandidate(request, candidates, amount);
}

/**
 * Iterate the deterministic candidate order and return the first
 * statically-covering grant. Extracted from `classifyGrantCoverage` to keep
 * both functions simple (single responsibility each).
 */
function selectCandidate(
  request: CoverageRequest,
  candidates: CoverageCandidateGrant[],
  amount: string,
): CoverageDecision {
  const amountValue = BigInt(amount);

  // Reject malformed persisted values before sorting, preserving a strict
  // total order among candidates with valid decimal cap strings.
  const valid = candidates.filter(
    (grant) =>
      parseCap(grant.maxPerTransfer) !== null &&
      parseCap(grant.maxCumulative) !== null,
  );
  const ordered = [...valid].sort(compareCandidates);

  // A policy-less candidate must not block a ready sibling.
  let policyNotReady = false;
  let capExceeded = false;
  for (const grant of ordered) {
    if (grant.walletId !== request.walletId) continue;
    if (grant.createdAt > request.now) continue;
    if (grant.state !== "active" || request.now >= grant.expiresAt) continue;
    if (grant.action !== request.action || grant.chain !== request.chain) continue;
    if (!grant.recipients.includes(request.recipient)) continue;

    if (!grant.providerPolicyId) {
      policyNotReady = true;
      continue;
    }

    const perTransferCap = parseCap(grant.maxPerTransfer);
    if (perTransferCap === null) continue;
    if (compareAmounts(amountValue, perTransferCap) > 0) {
      capExceeded = true;
      continue;
    }

    return {
      outcome: "covered",
      grantId: grant.id,
      amountSmallestUnits: amount,
    };
  }

  if (policyNotReady) return { outcome: "degrade", reason: "policy_not_ready" };
  if (capExceeded) {
    return { outcome: "degrade", reason: "per_transfer_cap_exceeded" };
  }
  return { outcome: "degrade", reason: "no_candidate" };
}
