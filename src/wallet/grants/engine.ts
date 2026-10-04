/**
 * DGC-2: pure delegated-grant evaluation engine.
 *
 * Chain-agnostic, I/O-free: decisions are pure functions of
 * (grant, execution request, window consumption, clock). The Solana recipient
 * validator plugs in through CHAIN_VALIDATORS; unregistered chains fail closed
 * (validator_unavailable), matching the spec's closed-degradation contract.
 *
 * Numeric amounts are decimal strings (SMALLEST UNIT: lamports for native SOL,
 * base units for SPL tokens). No floats anywhere.
 */

export type DelegatedGrantRecord = {
  id: string;
  userId: string;
  walletId: string;
  action: "transfer";
  chain: string;
  /** Per-transfer ceiling in smallest units (decimal string). */
  maxPerTransfer: string;
  /** Cumulative ceiling within the rolling window (decimal string). */
  maxCumulative: string;
  windowSeconds: number;
  /** Recipient allowlist (chain-encoded addresses); empty list authorizes none. */
  recipients: string[];
  state: "active" | "revoked" | "expired";
  providerPolicyId: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

export type GrantExecutionRequest = {
  action: "transfer";
  chain: string;
  /** Requested amount in smallest units (decimal string). */
  amount: string;
  recipient: string;
  /** Execution timestamp (epoch ms). Injected, never read from system clock. */
  now: number;
};

export type GrantWindowConsumption = {
  /** Already-consumed total within the rolling window (decimal string). */
  consumedInWindow: string;
};

export type GrantDecision =
  | { decision: "covered" }
  | { decision: "degrade"; reason: GrantDegradeReason };

export type GrantDegradeReason =
  | "action_not_covered"
  | "grant_revoked"
  | "grant_expired"
  | "per_transfer_cap_exceeded"
  | "cumulative_cap_exceeded"
  | "recipient_not_allowed"
  | "recipient_invalid"
  | "validator_unavailable";

type ChainValidator = {
  /** Format-level recipient validation; semantics live in allowlist + policy layers. */
  validateRecipient(recipient: string): boolean;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function isBase58(value: string): boolean {
  if (value.length === 0 || value.length > 44) return false;
  for (const char of value) {
    if (!BASE58_ALPHABET.includes(char)) return false;
  }
  return true;
}

const CHAIN_VALIDATORS: Record<string, ChainValidator> = {
  solana: { validateRecipient: isBase58 },
};

function normalizeDecimal(value: string): string {
  return value.replaceAll("_", "");
}

function compareDecimals(a: string, b: string): number {
  const bigA = BigInt(normalizeDecimal(a));
  const bigB = BigInt(normalizeDecimal(b));
  if (bigA < bigB) return -1;
  if (bigA > bigB) return 1;
  return 0;
}

function addDecimals(a: string, b: string): string {
  return (BigInt(normalizeDecimal(a)) + BigInt(normalizeDecimal(b))).toString();
}

/**
 * Evaluate one execution request against one grant. Order of checks is
 * deterministic and audited: identity of scope → lifecycle → caps → recipient.
 */
export function evaluateGrant(
  grant: DelegatedGrantRecord,
  request: GrantExecutionRequest,
  window: GrantWindowConsumption,
): GrantDecision {
  if (request.action !== grant.action || request.chain !== grant.chain) {
    return { decision: "degrade", reason: "action_not_covered" };
  }
  if (grant.state !== "active") {
    return { decision: "degrade", reason: "grant_revoked" };
  }
  if (request.now >= grant.expiresAt) {
    return { decision: "degrade", reason: "grant_expired" };
  }
  if (compareDecimals(request.amount, grant.maxPerTransfer) > 0) {
    return { decision: "degrade", reason: "per_transfer_cap_exceeded" };
  }
  const projectedTotal = addDecimals(window.consumedInWindow, request.amount);
  if (compareDecimals(projectedTotal, grant.maxCumulative) > 0) {
    return { decision: "degrade", reason: "cumulative_cap_exceeded" };
  }

  const validator = CHAIN_VALIDATORS[grant.chain];
  if (!validator) {
    return { decision: "degrade", reason: "validator_unavailable" };
  }
  if (!validator.validateRecipient(request.recipient)) {
    return { decision: "degrade", reason: "recipient_invalid" };
  }
  if (!grant.recipients.includes(request.recipient)) {
    return { decision: "degrade", reason: "recipient_not_allowed" };
  }
  return { decision: "covered" };
}
