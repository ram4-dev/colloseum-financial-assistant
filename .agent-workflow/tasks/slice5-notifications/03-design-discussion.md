# Design discussion — Slice 5: Observable notifications

## Proposed outcome

Show a durable, authenticated activity feed in the web app for assistant-initiated operations and relevant inbound wallet activity. Deliver provider-signed webhooks quickly, reconcile missed or unsupported provider events through polling, and use LiveKit `conversation_state_changed` only as a low-latency refresh signal for active conversations.

## Bound decisions

- D-5 from Ramiro: signed provider webhooks plus polling reconciliation; publish revisions through the existing `revision-publisher`/`conversation_state_changed` topic. No native push in this slice.
- One canonical notification is produced regardless of whether an underlying event came from a webhook, an operation state change, or reconciliation. Source-specific receipt details remain internal.
- A notification is scoped to the resolved wallet owner. API reads and mutations require authenticated identity and RLS/user predicates.
- The feed is available outside an active voice session. Read state is per user; delivery state is not inferred from LiveKit.

## Product questions / assumptions to confirm at the outline gate

1. “Relevant” inbound activity means confirmed SOL and SPL-token deposits visible from the user's one enrolled Solana wallet; spam-token filtering and pricing are excluded.
2. Send notifications for operation states `submitted`, `confirmed`, and terminal failure/revert; avoid a separate notification for every transient polling observation.
3. Show time, asset/amount when known, direction, status, and a devnet explorer link; never expose provider payloads, webhook secrets, authorization headers, signing details, or unnecessary counterparties.
4. The feed may refresh on page focus and bounded interval while visible, while LiveKit revision events trigger immediate refresh. Browser notifications and native push are excluded.

## Technical shape

- Add a notification ledger with unique `(user_id, dedupe_key)`, category/status, safe projection JSON, optional `wallet_id`, `operation_id`, `conversation_id`, event timestamp, created/read timestamps, and RLS. Add reconciliation cursor state per wallet/network.
- Add a single ingestion service that validates ownership and normalized event fields, deduplicates transaction/source events, inserts notification(s), then publishes conversation revision invalidation where a conversation is attached. A durable insert must succeed before fan-out.
- Add an authenticated paginated feed/read API. A webhook route is separate from identity-authenticated routes, verifies raw bytes using the provider signature contract, resolves provider wallet identity to the local wallet, and never trusts a user ID from payload.
- Add a bounded reconciliation loop with one active run per wallet, persisted cursors, page limits, overlap-safe re-reading, backoff, and shutdown cancellation. It queries Solana RPC/provider history for confirmed signatures; webhook ingestion and operation lifecycle ingestion share dedupe rules.
- Add an activity/feed surface in the existing web app. Fetch on mount/focus and bounded visible-page interval; show unread state and allow mark-read. When an active conversation receives LiveKit `conversation_state_changed`, refresh its conversation and relevant feed state.
- Provider event capability is an enablement gate: verify exact event types and wallet scope for the configured Privy embedded-wallet product before relying on webhook coverage. The RPC reconciler remains the recovery and coverage path.

## Main risks

- A wallet's incoming transaction history may require RPC/provider APIs and rate limits not covered by current provider methods.
- A transaction can be observed first by polling and later by webhook; canonical dedupe key must be chain/network + signature + wallet + event class, while webhook ID separately prevents delivery replay.
- Reconciliation in multiple API replicas must not duplicate work or skip events; use DB leasing/advisory locking or a durable queue, and cursor overlap.
- Fastify's default parsed body is not suitable for signature validation; register an isolated raw-body parser/route and test exact bytes.
- Feed correctness must not depend on process-local listeners; LiveKit publish failures cannot roll back the notification insert.

## Design gate status

The Slice 5 scope and D-5 are authorized. The technical outline is ready for independent Pi/GLM 5.3 review and then the HumanLayer design gate. The current session exposes no Herdr/Pi session controls, so no independent review has been claimed. Do not start runtime code until that required review/gate is complete. Slices 6–7 remain excluded.
