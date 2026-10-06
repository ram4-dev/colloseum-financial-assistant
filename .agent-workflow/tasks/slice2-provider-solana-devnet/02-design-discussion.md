# Design Discussion — Slice 2: Solana devnet WalletProvider

**Date:** 2026-10-04
**Inputs:** `01-exploration.md`; plan Slice 2
(`01-propuesta-plan.md:148-163`); G4 research
(`06-research-d4-privy-solana.md`); Slice 1 ADR-1
(`openspec/changes/delegated-grant-core/design.md`).

## Current state

Three providers exist behind `WalletProvider` (`src/wallet/provider.ts`):
`FixtureWalletProvider` (default, deterministic), `WdkWalletProvider`
(EVM/WDK, `mode: live`), `CircleArcProvider` (Arc testnet, `mode: live`,
fail-closed boot guard on network/token, injectable RPC + client doubles in
tests). Runtime selection is `WDK_TOOLS_SOURCE`-driven in
`src/runtime/dependencies.ts`. No Solana provider exists; the grants engine
already plugs a base58 Solana recipient validator
(`src/wallet/grants/engine.ts:79`), and `privy-policy-sync.ts` deliberately
deferred the Solana policy adapter to this slice.

## Desired state

A devnet-only `SolanaDevnetProvider` implementing `WalletProvider`, selected
by `WDK_TOOLS_SOURCE=solana-devnet`, that:

- reads balance and address via Solana JSON-RPC on devnet;
- previews transfers with explicit fee evidence and a policy fee ceiling;
- broadcasts transfers by asking **Privy** to sign server-side
  (embedded-wallet custody per ADR-1 — never a local keypair, never a secret
  in this repo) and submitting the signed transaction to the devnet RPC;
- returns strict `BroadcastOutcome`s (`submitted` / `uncertain` /
  `not_dispatched`) and never interprets an ambiguous dispatch as success;
- maps `getSignatureStatuses` confirmation statuses to `FinalityOutcome`
  (`finalized` → `confirmed`, on-chain error → `reverted`), with polling
  deadline and abort support;
- handles `uncertain` by exposing the signature once known and never
  re-broadcasting (reconciliation reads status by signature);
- reports devnet as `kind: 'testnet'` with an explicit explorer URL entry.

## Options considered

### Option A — `@solana/kit` + Privy signing (initially chosen; SUPERSEDED 2026-10-04 by ADR-1 revision — Kit peers incompatible with Circle/Privy/TS6)

Kit 8.4.0 is the officially recommended SDK (dated evidence in
01-exploration.md Q5). Privy holds custody and signs server-side; Kit provides
address validation, transaction/message handling, and typed RPC clients.

- ✅ Modern, maintained SDK; aligns with Slice 1's Privy-based custody.
- ✅ No new secret surfaces; signing stays in Privy's enclave path.
- ⚠️ Kit's API is function-first and newer; unit tests must inject the RPC
  transport to stay deterministic. Acceptable — `CircleArcProvider` already
  proves the injectable-double pattern.

### Option B — `@solana/web3.js` 1.x + Privy signing (chosen after ADR-1 revision)

- ✅ Most familiar API, huge ecosystem.
- ⚠️ Officially "legacy" (solana.com docs, fetched 2026-10-04) — the label
  that initially ruled it out. Registry evidence the same day showed Kit
  cannot resolve against installed Circle/Privy peers or repo TS 6, and
  web3.js 1.98.4 (maintained) resolves cleanly and covers this slice's
  read-only needs. Chosen as the lower-risk option; supersession recorded
  in design ADR-1.

### Option C — WDK Solana tools (same path as `WdkWalletProvider`)

- ❌ WDK toolset in this repo is EVM-shaped (sepolia fixtures, hex hashes);
  the plan requires the provider seam + devnet registration, and G4 evidence
  is Privy-specific. Rejected.

## Tradeoffs and consequences

1. **Devnet-only hard guard.** Every method asserts
   `network === 'solana-devnet'`; the constructor additionally refuses if
   `WDK_NETWORK` names anything else when wiring selects this provider. There
   is no code path to mainnet. Tradeoff: a future mainnet slice rewrites the
   guard — accepted, this slice's evidence is devnet-only (plan F2 note).
2. **Broadcast outcome discipline.** A Privy/RPC timeout after submission
   returns `uncertain` (never a fabricated `submitted`), mirroring
   `CircleArcProvider`'s deadline loop. The preview+confirm+idempotency flow
   upstream stays authoritative; no caller changes.
3. **Fee policy.** Preview computes/quotes a fee from RPC evidence
   (`getFeeForMessage`-style estimate is not available pre-signing without the
   message; the provider uses a conservative constant ceiling check on the
   lamports-per-signature value from the RPC and reports it in the preview).
   Tradeoff: constant may over/under-estimate volatile devnet fees; the
   ceiling (e.g. 0.00001 SOL) is a policy constant, documented and testable.
4. **History.** Devnet history via `getSignaturesForAddress` is best-effort;
   Slice 2's observable result needs balance + transfer + finality, not
   ledger analytics. Return an empty ledger like `CircleArcProvider` did in
   its slice, documented. Tradeoff: thinner demo; honest over fabricated.
5. **Preservation of other providers.** Selection is strictly additive:
   new branch in `createWalletProvider` keyed on a new
   `WDK_TOOLS_SOURCE=solana-devnet` value; all other values keep exact current
   behavior. `wallet-provider.test.ts` extended with selection tests, existing
   tests untouched.
6. **No mainnet/live funds/secrets.** No private keys, seeds, or mnemonics in
   code or tests; Privy credentials flow only via existing env config
   (`PRIVY_APP_ID`/`PRIVY_APP_SECRET`), never logged; the devnet RPC is
   public. The provider refuses `mode` reuse beyond `live` and refuses any
   network that is not devnet.

## Open questions

None blocking. The Privy Solana RPC call shape is encapsulated behind an
injectable `SolanaSignerClient` interface; if the live call shape differs at
smoke-test time, only the adapter function changes, not the contract.

## Decision record

**Initial:** Option A approved with the six consequences above. **Final
(revised 2026-10-04): Option B — `@solana/web3.js@1.98.4`** per design
ADR-1 revision (Kit peer incompatibility with Circle/Privy/TS6). Option A's
consequences 1-6 otherwise stand unchanged.
