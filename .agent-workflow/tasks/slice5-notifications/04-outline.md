# Implementation outline — Slice 5

## Goal

Give the user a durable, authenticated activity inbox that records assistant transfer lifecycle and supported confirmed Solana devnet activity. Signed provider events reduce latency; cursor-based reconciliation recovers misses. The feed remains available outside LiveKit.

## Invariants

1. PostgreSQL is the notification source of truth; an HTTP feed can recover every committed notification. Assistant attempt transitions enter a transactional outbox in the same transaction as the status change; dispatch retries until notification insert and outbox completion commit together.
2. Verify provider signature over exact raw bytes before parse, wallet lookup, receipt insert, or side effect.
3. Resolve wallet ownership from local records; never trust provider payload user IDs.
4. Webhook delivery IDs and canonical chain event keys make retries and webhook/poll overlap idempotent.
5. Cursor progress follows durable event processing; a failed page can be safely retried with bounded overlap.
6. Store only safe display fields. Publish LiveKit invalidation after DB commit; LiveKit failure cannot undo notification state.
7. Polling remains complete if configured Privy embedded-wallet events do not cover an event class. No native push, multi-wallet, swaps, grants, signing changes, or new chain.

## Execution order

1. Strict-TDD RED: signature/replay/ownership, normalization/projection/dedupe, RLS, cursor/retry/race, and frontend refresh tests.
2. Schema and backend GREEN: RLS notification/receipt/cursor tables; shared event ingest; auth feed/read API; raw-body webhook endpoint; bounded per-wallet reconciler and lifecycle wiring.
3. Assistant lifecycle and LiveKit integration: write outbox events atomically for `conversation_transfer_attempts` transitions (`submitted`, `uncertain`, `confirmed`, `reverted`, `receipt_invalid`) and key notifications by attempt ID + state. `uncertain` is shown as unresolved; retryable `not_dispatched` returning to `previewed` is intentionally notification-free. Do not treat process-local `FinancialTaskRegistry` signals as durable events. `wallet_operations` is a separate pipeline with no production construction found in `src`; support it only through a separate adapter if it becomes production-wired. Publish existing conversation revision invalidation after notification commit.
4. Frontend: typed feed client, inbox/unread state, mark read, focus refresh, 30-second visible-page polling, and LiveKit invalidation refresh.
5. Verification: configured PostgreSQL migration/RLS/integration tests, backend/frontend lint/typecheck/build/full tests, fake provider/RPC browser E2E, migration and rollback review; pass exact SHA to Hermes.
6. Delivery: phase commits on `slice5-notifications`, incremental push, one reviewable PR targeting Slice 4, no merge.

## Acceptance evidence

- Invalid signature produces no DB receipt, notification, or fan-out.
- Duplicate delivery and overlapping webhook/poll observation result in one notification.
- Cursor stays retryable after an event/page persistence failure.
- Two-user DB test proves read and mark-read isolation; system-context tests prove workers can access only system-owned event tables, not notification feed rows.
- Crash/restart test proves a committed assistant status transition is replayed from the transactional outbox into one notification; a concurrent dedupe loser creates no duplicate invalidation.
- Simulated confirmed inbound event and assistant operation appear in the browser inbox without reload and with safe projection.
- LiveKit failure leaves the inbox notification readable by HTTP.
- Provider-specific webhook coverage is verified before configuring live subscription; otherwise RPC recovery tests prove complete event coverage.
- `not_dispatched` is explicitly excluded from the inbox because it is not dispatched, the attempt remains retryable as `previewed`, and the conversation already reports the error. `uncertain` must appear because funds may have moved.

## Known design risks

- Privy public webhook descriptions differ by product; verify embedded Solana wallet support and finality before enabling subscriptions.
- Solana RPC pagination, history retention, and rate limits are not yet established for the configured endpoint.
- The current local Solana provider history method is a stub and must be extended behind a narrow interface.

## Approval state

Scope and D-5 are user-authorized. This is a reviewable outline, not an authorization to begin runtime implementation under the repository's HumanLayer gate. Independent Pi/GLM 5.3 review and the design approval record remain pending.
