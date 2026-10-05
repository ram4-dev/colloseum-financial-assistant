# Tasks: Explicit voice confirmation (Slice 4)

## 1. Strict TDD — tests first

- [ ] 1.1 Unit-test per-preview, one-use voice confirmation/cancellation evidence: final-only, exact phrases including standalone localized yes/sí, narration completion/interruption, transcript ordering, replay, replacement preview, missing evidence, unknown speaker identity, and no parallel generic resolution route.
- [ ] 1.2 Extend strict realtime tool tests: tool call alone cannot authorize; response remains address-free; preview includes amount/name/fee.
- [ ] 1.3 Add chain-aware contacts repository/API tests for legacy EVM default, explicit Solana devnet, canonical base58, version updates and wrong-network rejection.
- [ ] 1.4 Add Solana voice service tests for decimal-to-lamport precision, configured live maximum, stale contact version, preview, cancellation, single broadcast and finality.
- [ ] 1.5 Add worker/session fake E2E proving only a post-read-back final spoken confirmation enables broadcast; include cancel, stale, interim, interrupted narration, early confirmation, forged tool-call, duplicate race, and no double-routing cases.
- [ ] 1.6 Add frontend contact editor/render tests for selecting network and showing Solana network; keep existing EVM contacts compatible.
- [ ] 1.7 Add provider regression proving a missing preview ID cannot synthesize a timestamp-based idempotency key or dispatch.
- [ ] 1.8 Add projection regression proving confirmed Solana state uses the devnet explorer URL.

## 2. Implementation — GREEN

- [ ] 2.1 Implement the voice decision gate and wire final LiveKit transcripts from the authenticated single room participant into each session; fail closed on unknown/mismatched speaker or ordering uncertainty. Do not fan the same transcript into generic service handling.
- [ ] 2.2 Make `send_token` use worker-controlled exact preview narration and arm the gate only after uninterrupted audio playout finishes.
- [ ] 2.3 Add backward-compatible chain/network fields and migrations to versioned contact/memory records, routes, contracts, and UI.
- [ ] 2.4 Implement chain-aware recipient validation and transfer policy; enforce `solana-devnet`, native SOL, exact lamports, configured live maximum, no oracle; preserve EVM behavior and keep Slice 2 grant cap separate.
- [ ] 2.5 Return display-safe contact name and fee in the voice tool result; update concise English/Spanish instructions for exact preview and explicit confirmation.
- [ ] 2.6 Keep provider claim/idempotency/finality path canonical and prove stale/race/uncertain outcomes.
- [ ] 2.7 Use the network-aware explorer projection for terminal transfer state.

## 3. Verification

- [ ] 3.1 Focused backend, frontend, and fake-worker E2E tests.
- [ ] 3.2 Backend lint, typecheck, build, full tests with Postgres; frontend lint, typecheck and tests.
- [ ] 3.3 `npm run eval` because agent instructions change.
- [ ] 3.4 Browser E2E of creating a Solana contact and observing voice preview/confirmation state; report unavailable external credentials explicitly.
- [ ] 3.5 Independent SDD verification against scenarios and source evidence.

## 4. Delivery

- [ ] 4.1 Commit by phase and push branch `slice4-voice-confirmation`.
- [ ] 4.2 Open a reviewable PR against `slice3-grant-execution`; do not merge.
- [ ] 4.3 Record CI and Hermes test handoff, worktree/session receipt, and final verification.
