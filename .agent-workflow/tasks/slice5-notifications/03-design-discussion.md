# Design discussion — Slice 5: Observable notifications

## Proposed outcome

Show a durable, authenticated activity feed in the web app for assistant-initiated operations and relevant inbound wallet activity. Deliver provider-signed webhooks quickly, reconcile missed or unsupported provider events through polling, and use LiveKit `conversation_state_changed` only as a low-latency refresh signal for active conversations.

## Bound decisions

- D-5 from Ramiro: signed provider webhooks plus polling reconciliation; publish revisions through the existing `revision-publisher`/`conversation_state_changed` topic. No native push in this slice.
- One canonical notification is produced regardless of whether an underlying chain event came from a webhook or reconciliation. Assistant transfer lifecycle notifications are derived from durable `conversation_transfer_attempts` state transitions, not process-local task events. `wallet_operations` is a separate pipeline and is not assumed to represent assistant transfers. Source-specific receipt details remain internal.
- A notification is scoped to the resolved wallet owner. API reads and mutations require authenticated identity and RLS/user predicates.
- The feed is available outside an active voice session. Read state is per user; delivery state is not inferred from LiveKit.

## Product questions / assumptions to confirm at the outline gate

1. “Relevant” inbound activity means confirmed SOL and SPL-token deposits visible from the user's one enrolled Solana wallet; spam-token filtering and pricing are excluded.
2. Persist notifications for assistant attempt states `submitted`, `uncertain`, `confirmed`, `reverted`, and `receipt_invalid`; dedupe by attempt ID + state. An uncertain notification must say the outcome is unknown, because dispatch may have succeeded. `not_dispatched` returns the attempt to `previewed`, is retryable, and produces no inbox notification; the existing conversation response remains the user feedback.
3. Show time, asset/amount when known, direction, status, and a devnet explorer link; never expose provider payloads, webhook secrets, authorization headers, signing details, or unnecessary counterparties.
4. The feed refreshes on page focus and every 30 seconds while visible; LiveKit revision events trigger immediate refresh. Browser notifications and native push are excluded.

## Technical shape

- Add a notification ledger with unique `(user_id, dedupe_key)`, category/status, safe projection JSON, optional `wallet_id`, `operation_id`, `conversation_id`, event timestamp, created/read timestamps, and user-scoped RLS. Add reconciliation cursor/lease and webhook receipt tables with system-context-only RLS policies; these are not user feed data and must be writable by the server worker in anonymous service transactions.
- Add a single ingestion service that validates ownership and normalized event fields, deduplicates transaction/source events, inserts notification(s), then publishes conversation revision invalidation where a conversation is attached. For assistant transitions, use the `conversation_transfer_attempts` ID + persisted state as the idempotency identity. A durable insert must succeed before notification fan-out; existing conversation state revisions remain an independent refresh signal.
- Add a transactional outbox event in the same database transaction as each notification-worthy assistant attempt transition. A worker retries unprocessed outbox events through the canonical ingestion path; notification insertion and marking the outbox event processed commit atomically. This closes the process-crash gap between the durable attempt update and notification persistence. LiveKit invalidation happens after commit and may fail safely because the feed is durable and polls while visible.
- Add an authenticated paginated feed/read API. A webhook route is separate from identity-authenticated routes, verifies raw bytes using the provider signature contract, resolves provider wallet identity to the local wallet, and never trusts a user ID from payload.
- Add a bounded reconciliation loop with one active run per wallet, persisted cursors, page limits, overlap-safe re-reading, backoff, and shutdown cancellation. It queries Solana RPC/provider history for confirmed signatures; webhook ingestion and operation lifecycle ingestion share dedupe rules.
- Add an activity/feed surface in the existing web app. Fetch on mount/focus and bounded visible-page interval; show unread state and allow mark-read. When an active conversation receives LiveKit `conversation_state_changed`, refresh its conversation and relevant feed state.
- Provider event capability is an enablement gate: verify exact event types and wallet scope for the configured Privy embedded-wallet product before relying on webhook coverage. The RPC reconciler remains the recovery and coverage path.

## Main risks

- A wallet's incoming transaction history may require RPC/provider APIs and rate limits not covered by current provider methods.
- A transaction can be observed first by polling and later by webhook; canonical dedupe key must be chain/network + signature + wallet + event class, while webhook ID separately prevents delivery replay. Concurrent insert losers use `ON CONFLICT DO NOTHING`; only the winning insert publishes invalidation.
- Reconciliation in multiple API replicas must not duplicate work or skip events; use DB leasing/advisory locking or a durable queue, and cursor overlap.
- Fastify's default parsed body is not suitable for signature validation; register an isolated raw-body parser/route and test exact bytes.
- Feed correctness must not depend on process-local listeners; LiveKit publish failures cannot roll back the notification insert. Assistant attempt events are captured transactionally in the outbox before the worker sees them.
- The Svix replay timestamp tolerance is five minutes in its libraries; keep the verifier contract and a ±300-second boundary test explicit, with server clock synchronization required.

## Fixed implementation contracts

- Table RLS: notification projections are accessible only when `app.user_id = user_id`. Attempt transitions insert outbox rows in that user transaction. The worker enumerates minimal event references in anonymous service context, then re-enters the resolved owner's transaction to insert a notification and mark its event complete. Webhook receipts, reconciliation cursors/leases, and the narrow provider-wallet resolver are system-context-only; feed routes never expose them. Prove both boundaries with PostgreSQL tests.
- The inbox refreshes every 30 seconds while visible, on focus, and immediately after `conversation_state_changed`.
- MVP feed layout is a flat time-ordered list with unread state; no attempt grouping.
- Enforce a 300-second past/future webhook timestamp window and synchronized server time.
- Assistant state mapping: `submitted`, `uncertain`, `confirmed`, `reverted`, and `receipt_invalid` each get one safe notice. `uncertain` communicates unknown outcome and no automatic retry; `not_dispatched` returns to `previewed`, stays retryable, and remains conversation-only.
- Use an outbox rather than accepting crash loss: attempt-state update + outbox insert are atomic; the worker commits notification insert + outbox completion together. LiveKit failure after commit is recovered by bounded HTTP refresh.

## Design gate status

The Slice 5 scope and D-5 are authorized. Pi/GLM 5.3 completed the independent review at `f4d0aa1`; findings F1–F6 were resolved in `808f0da`. The read-only final check at `808f0da` passed with no blockers; its session and evidence are recorded in `05-independent-review.md`. The inherited user authorization now permits Strict-TDD apply. Slices 6–7 remain excluded.
