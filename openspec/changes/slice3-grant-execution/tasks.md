# Tasks: Slice 3 — Grant Execution

Binding: `spec.md` (45 scenarios); AD-1..AD-9. Strict TDD: RED/GREEN/TRIANGULATE/REFACTOR.

Estimated changed lines: 900–1,300. 400-line budget risk: High.
Chained PRs recommended: No.
Decision needed before apply: No
Chain strategy: size-exception
400-line budget risk: High

PR #3 stacks on `origin/slice2-provider-solana-devnet` until PR #2 merges. Hermes gates post-PR; run DB suites on Postgres.

## Phase 1 — Unit RED: amount and eligibility

- [x] 1.1 Test exact SOL-to-lamport conversion (`0.01` = `10000000`), unknown decimals, malformed/non-integral input, and +1 rejection.
- [x] 1.2 Test classification for active, expired, revoked, over-cap, recipient/chain/action/wallet mismatch, and `policy_not_ready`.
- [x] 1.3 Test deterministic least-privilege selection and each Q3 tiebreaker.
- [x] 1.4 Test original intent binding: ambiguous amount/recipient, later grant, or model/tool-origin request never qualifies; tool args cannot fill missing intent.
- [x] 1.5 Assert classifier takes static inputs only and cannot read DB or consumption state.

## Phase 2 — Classifier GREEN

- [x] 2.1 Implement `src/conversations/grant-coverage.ts` with integer-only conversion using provider token decimals.
- [x] 2.2 Implement static grant evaluation, stable candidate ordering, and preview origin/intent metadata.
- [x] 2.3 Refactor; rerun unit tests, typecheck, lint.

## Phase 3 — Conversation RED/GREEN

- [ ] 3.1 RED service tests: covered request returns `sent` without confirmation; ineligible request uses existing preview-confirm flow and honest copy.
- [ ] 3.2 Add optional grant/converter dependencies to `src/conversations/service.ts`; absence preserves current behavior; wire in `src/server.ts`.
- [ ] 3.3 Reuse `runFinancialTransfer`; expose no reason code; assert HTTP contract parity (`src/contracts/http.ts` and frontend `api-types.ts`).

## Phase 4 — Atomic claim RED/GREEN

- [ ] 4.1 RED DB tests: `claimConsumption` rechecks state/window and records claim/audit before broadcast; no pre-filter `consumedInWindow` call.
- [ ] 4.2 RED races: distinct claims yield one consumption; revoke/expiry before claim rejects; boundary and +1 amounts are deterministic.
- [ ] 4.3 RED replay: same key reuses claim without duplicate audit/consumption; broadcast and crash retry require winning `claimPendingTransfer`.
- [ ] 4.4 Implement ordered candidate fallback and audited degradation; run DB integration tests against real Postgres.

## Phase 5 — Typed/voice parity and E2E

- [ ] 5.1 RED parity tests: same intent/ledger yields same typed/transcript decision; degraded preview supports confirm/cancel.
- [ ] 5.2 RED tool tests: model-origin `send_token` remains preview-only; no grant or direct-broadcast tool exists.
- [ ] 5.3 Mark LiveKit tool previews ineligible; keep realtime tool surface unchanged.
- [ ] 5.4 Add fixture E2E for covered typed and voice requests plus degraded confirmation; no live credentials.

## Phase 6 — Verification and scope

- [ ] 6.1 Verify expiry-at-boundary, window/cap +1, and stable tie ordering.
- [ ] 6.2 Run lint, typecheck, full DB-backed tests, and E2E; record outcomes.
- [ ] 6.3 Confirm HTTP contract mirrors and diff contains no provider, LiveKit tool, or transfer-pipeline changes.

## Phase 7 — Delivery gates

- [ ] 7.1 Apply is authorized under Ramiro’s standing instruction; no approval pause.
- [ ] 7.2 Push the slice branch and open one stacked PR; obtain Hermes test and bounded review.
- [ ] 7.3 Record post-apply verification and delivery status in `state.yaml`.
