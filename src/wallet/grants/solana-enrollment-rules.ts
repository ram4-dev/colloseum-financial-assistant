/**
 * Solana consent-enrollment policy rules (task 2.7, solana-devnet-provider).
 *
 * Enrollment for Solana wallets attaches a composed policy to the exact
 * readback-verified signer. Each rule uses Privy's Solana policy DSL:
 *   - recipient allowlist via `solana_system_program_instruction` Transfer.to
 *   - per-transfer lamport ceiling via Transfer.lamports
 *   - static expiry via `system` current_unix_timestamp (lt)
 *
 * These shapes are pinned by tests/unit/grants-policy-provisioner.test.ts
 * (task 1.11) and verified against Privy's documented Solana examples.
 */

export type SolanaEnrollmentRule = {
  action: "ALLOW";
  resource: { method: "signAndSendTransaction"; chain: string };
  conditions: Array<Record<string, unknown>>;
};

/** Devnet CAIP-2 for Solana (matches the provider's network). */
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/**
 * Builds the single ALLOW rule for a Solana signer enrollment: recipient
 * allowlist AND per-transfer lamport ceiling (static expiry is added by the
 * provisioner per grant; enrollment policies use the same field sources).
 */
export function buildSolanaEnrollmentRules(input: {
  recipients: string[];
  /** Per-transfer ceiling in lamports (decimal string). */
  maxLamports: string;
}): SolanaEnrollmentRule[] {
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new Error(
      "buildSolanaEnrollmentRules: at least one recipient is required.",
    );
  }
  return [
    {
      action: "ALLOW",
      resource: {
        method: "signAndSendTransaction",
        chain: SOLANA_DEVNET_CAIP2,
      },
      conditions: [
        {
          field_source: "solana_system_program_instruction",
          field: "Transfer.to",
          operator: "in",
          value: input.recipients,
        },
        {
          field_source: "solana_system_program_instruction",
          field: "Transfer.lamports",
          operator: "lte",
          value: input.maxLamports,
        },
      ],
    },
  ];
}
