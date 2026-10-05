# Tasks: Durable wallet and assistant notifications

## Review Workload Forecast

| Field | Value |
| --- | --- |
| Estimated changed lines | 650–900 |
| 400-line budget risk | High |
| Chained PRs recommended | No; Ramiro authorized one reviewable PR per slice |
| Suggested split | Single PR for Slice 5 with phase commits |
| Delivery strategy | exception-ok — one PR per slice is the explicit delivery boundary |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Durable feed, ingestion, reconciliation, UI | Slice 5 PR | `npm test -- tests/unit/notifications tests/integration/notifications` | Browser E2E with fake provider/RPC; no funds | Disable ingress/reconciler, hide feed; keep additive tables |

## Phase 1: RED contracts

- [x] 1.1 RED: raw-byte signatures, ±300-second timestamps, wallet identity resolution, and invalid-webhook no-side-effects.
- [x] 1.2 RED: assistant state mapping (`uncertain` included, `not_dispatched` excluded), outbox replay, dedupe race, and safe projection.
- [x] 1.3 RED: cursor retry/order, worker exclusion/backoff, and user/system RLS boundaries.
- [x] 1.4 RED frontend: empty/unread/read, focus/visible polling, LiveKit refresh.

## Phase 2: Durable backend

- [x] 2.1 Create additive migration for notifications, assistant lifecycle outbox, webhook receipts, reconciliation cursors/leases, indexes, grants, and table-specific RLS.
- [x] 2.2 Add idempotent owner-scoped ingestion and safe display projection.
- [x] 2.3 Add authenticated feed/read API, raw-body signature verifier, scoped receipt dedupe.
- [x] 2.4 Add bounded Solana pages, overlap-safe cursors, worker lease, backoff, startup and shutdown.
- [ ] 2.5 Atomically outbox `submitted`, `uncertain`, `confirmed`, `reverted`, `receipt_invalid` attempt states; skip retryable `not_dispatched`.
- [ ] 2.6 Retry outbox through canonical ingestion; atomically insert notification/complete event; fan out only after winning insert. Keep `wallet_operations` separate.

## Phase 3: Frontend and integration

- [ ] 3.1 Add typed feed API, inbox, unread/read controls.
- [ ] 3.2 Refresh on focus, 30-second visible polling, and LiveKit revisions.
- [ ] 3.3 Fastify/browser E2E: assistant states and reconciled inbound event without reload.

## Phase 4: Verify and deliver

- [ ] 4.1 Run backend/frontend lint, typecheck, tests/build, PostgreSQL RLS and browser E2E.
- [ ] 4.2 Verify Privy embedded-Solana event coverage; document gaps and prove polling recovery before subscription.
- [ ] 4.3 Record SDD verification, commit by phase, push branch, open one Slice 5 PR, and hand exact SHA to Hermes for testing.
