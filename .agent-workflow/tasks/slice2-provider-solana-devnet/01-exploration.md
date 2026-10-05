# Exploration — Slice 2: Solana devnet WalletProvider

**Date:** 2026-10-04
**Worktree:** `/Users/ramiro/Desktop/projects/colloseum.slice2-provider-solana-devnet`
**Branch:** `slice2-provider-solana-devnet` (based on `delegated-grant-core` @ `607d3a3`)

## Research questions (current state only)

1. What is the `WalletProvider` seam and its normalized contract?
2. What test contract must a new provider satisfy?
3. How is a provider selected and wired at runtime?
4. What does the plan require for Slice 2, and what does gate G4 supply?
5. Which Solana client library is the correct, evidenced choice?

## Findings

### Q1 — The seam (`src/wallet/provider.ts`, 52 lines)

`WalletProvider` is an interface: `id`, `mode` (`fixture` | `live`), `health`,
`listNetworks`, `listTokens`, `getAddress`, `getBalance`, `getHistory`,
`previewTransfer`, `broadcastTransfer` (returns `BroadcastOutcome` =
`submitted` | `uncertain` | `not_dispatched`), `waitForFinality`
(`confirmed` | `reverted` | `receipt_invalid`), `close`.

`EXPLORER_URLS` maps network → explorer tx prefix (`sepolia`, `arc-testnet`);
the plan explicitly requires adding the devnet entry here
(`provider.ts:26-31` at plan time).

### Q2 — The test contract (`tests/unit/wallet-provider-contract.test.ts`)

`assertContract` exercises the full normalized lifecycle with an EVM-shaped
request (sepolia/USDT). A new provider is registered via `it.each`. The
contract test's fixtures are EVM-specific (hex addresses, `0x…` hashes), so a
Solana provider joins via an equivalent Solana-scoped contract test with the
same assertion shape, rather than being forced into the EVM fixture data.

`tests/unit/wallet-provider.test.ts` covers wiring selection behavior.
`tests/unit/circle-arc-provider.test.ts` is the reference pattern for a live,
network-gated provider with injected RPC/client doubles.

### Q3 — Runtime wiring (`src/runtime/dependencies.ts`)

`createWalletProvider(environment)` selects by `WDK_TOOLS_SOURCE`:
`circle-arc` → `CircleArcProvider` (with a D8-style boot guard asserting
`WDK_NETWORK=arc-testnet` and `WDK_TOKEN=USDC`), `live` → `WdkWalletProvider`,
else → `FixtureWalletProvider` (default, safe).

A Solana provider follows the same pattern: a dedicated
`WDK_TOOLS_SOURCE=solana-devnet` selector with a fail-closed boot guard
(mismatched `WDK_NETWORK`/`WDK_TOKEN` must throw at boot), so the default
fixture mode is untouched and every other provider is preserved.

### Q4 — Plan slice + G4 gate

Plan §4 Slice 2 (01-propuesta-plan.md:148-163): observable result is balance
read + test transfer on **Solana devnet** through preview → confirmation →
broadcast → finality, with `uncertain` handled (blocking + reconciliation), all
through the `WalletProvider` seam. Required paths: new
`src/wallet/solana-provider.ts` implementing `src/wallet/provider.ts`;
devnet entry in `EXPLORER_URLS`; deterministic fixture for CI
(`tests/unit/wallet-provider-contract.test.ts` as contract); client library
choice must be re-validated with dated evidence, not by default.

Gate G4 is satisfied by `06-research-d4-privy-solana.md` (verified
2026-10-03): Privy supports Solana devnet clusters and server-side signing;
per-instruction policies in enclave; documented ALT limitation is irrelevant
for simple transfers. Slice 1's `design.md` ADR-1 binds the hybrid decision
(Privy custody/policy + Postgres grants ledger).

Also binding from Slice 1 state: `grants/privy-policy-sync.ts` ships no Solana
policy adapter on purpose — denomination for the Solana policy adapter belongs
to the Solana slice.

### Q5 — Client library decision (dated primary sources, verified 2026-10-04)

- `@solana/kit` 8.4.0 is the recommended TypeScript SDK: "New apps should use
  `@solana/kit`" (solana.com/docs/clients/official/javascript, fetched
  2026-10-04); npm registry shows `@solana/kit@8.4.0`, `engines.node >=
  20.18.0` (registry.npmjs.org, fetched 2026-10-04).
- "`@solana/web3.js` is the legacy TypeScript SDK for Solana."
  (same page, fetched 2026-10-04).
- Devnet finality via JSON-RPC `getSignatureStatuses` returns
  `processed`/`confirmed`/`finalized` confirmation statuses
  (solana.com/docs/rpc/http/getsignaturestatuses, fetched 2026-10-04).

**Decision (2026-10-04, initial):** `@solana/kit`. Adding web3.js 1.x would
pull the legacy SDK into a new subsystem for no benefit. All signing remains
server-side via Privy.

**SUPERSEDED same day (see design ADR-1 revised):** registry evidence shows
Kit 8/6/5 cannot resolve against installed peers
(`@circle-fin/developer-controlled-wallets@10.8.0` → Kit ^2.1||…||^6;
`@privy-io/node@0.34.0` → Kit ^5.1.0; Kit 5.5.1 additionally requires
TypeScript ^5.0.0 vs repo TS 6.0.3). Final decision: `@solana/web3.js@1.98.4`
— the research facts above (Kit recommended, web3.js legacy) remain valid;
the conclusion changes because peer compatibility outweighs the legacy label
for a bounded read-only provider.

## Open items carried into design

- Privy Solana wallet RPC shape (`wallets/{id}/rpc`, `method:
  signAndSignTransaction` — exact method name and params) must be reflected
  into an injectable client interface, mirroring `CircleClient`'s
  injectable-client pattern, so unit tests need no network and no secrets.
- Devnet-only guard: provider must refuse any network other than
  `solana-devnet` — enforced in constructor + every method, mirroring
  `CircleArcProvider.assertNetwork` but stricter (no mainnet path at all).
- Deterministic CI coverage: injectable RPC + injectable Privy client; no
  devnet dependency in unit tests; optional smoke integration test gated by
  env var, never run by default.
