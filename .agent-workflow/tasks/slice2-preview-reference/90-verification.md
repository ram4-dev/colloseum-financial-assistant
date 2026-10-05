# Verification

## Unit checks and results

- RED: `npm test -- tests/unit/solana-devnet-provider.test.ts` failed as expected before the guard: 3 failures for `undefined`, empty, and whitespace-only preview IDs; each reached the signer and returned `submitted`.
- GREEN: same focused command passed after the guard: 12/12 tests.

## Integration and E2E

- `DATABASE_URL=postgres://postgres@127.0.0.1:55442/wdk_agent?... DEMO_USER_ID=00000000-0000-4000-8000-000000000001 npm test -- tests/integration/wallets-transfer.test.ts`: 7/7 passed against an isolated Postgres 16 container after migrations.
- `npm run test:e2e:livekit-fake`: 3/3 passed.
- Full backend suite with DB URL: 801 passed, 10 failed, 10 skipped. The local DB was initialized differently from CI; failures were missing `extensions` schema / `DEMO_USER_ID`, existing contacts/conversation tests timing out, and known demo-sentinel setup. The focused transfer integration passed after matching the CI search path and sentinel settings. Full CI on the pre-fix PR head was green; exact new SHA is pending GitHub/Hermes retest.
- No real Privy signer call or devnet transfer was made.

## Static analysis / typecheck / lint

- `npm run lint`: pass.
- `npm run typecheck`: pass.
- `npm run build`: pass.

## End-to-end or real-route checks

- The relevant fake LiveKit worker E2E passed 3/3; the operation pipeline integration passed 7/7 with isolated Postgres.
- A live Privy/devnet signing smoke test was not run; no live transfer was authorized.

## Manual checks and remaining items

- Confirm no generated `reference_id` remains in Solana dispatch and the exact persisted preview ID is still used: source review passed.
- Hermes: rerun the configured PR test set after push; this is assigned to Hermes by Ramiro.
- Live devnet signer/policy readback and a human-approved devnet signature remain deferred by the Slice 2 plan.

## Deviations and next owner

No design deviation. The guard follows the existing Slice 4 fix and the Slice 2 stable-reference requirement. Next owner: Hermes for configured test retest on the pushed PR #2 SHA; then PR review remains open and unmerged.
