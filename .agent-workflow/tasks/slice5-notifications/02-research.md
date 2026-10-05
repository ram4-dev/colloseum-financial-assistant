# Research — Slice 5: Observable notifications

Date: 2026-10-05
Worktree: `/Users/ramiro/Desktop/projects/colloseum.slice5-notifications`
Branch base: `slice4-voice-confirmation` at `10aab3e`.

## Current behavior

- `FinancialTaskRegistry` is process-local. `src/livekit/worker.ts` subscribes to its state-revision events and publishes a reliable LiveKit data message with topic `conversation_state_changed`; the web client refreshes conversation state from HTTP.
- `useConversationState` polls `/v1/conversations/:id/state` every 750 ms only while activity is `working` or `verifying`. It does not provide an inbox when the user has left LiveKit or when a conversation is inactive.
- The assistant conversation transfer path persists lifecycle in `conversation_transfer_attempts` (user/conversation scoped under RLS): `previewed → broadcasting → submitted → confirmed|reverted|receipt_invalid`, with `uncertain` for ambiguous dispatch. Its durable row carries the attempt ID, pending transfer, transaction hash, and provider results. `conversation_state.revision` is bumped on lifecycle writes and currently drives LiveKit invalidation.
- `wallet_operations` is a separate durable, user-scoped table used by `WalletTransferPipeline`; repository search finds its implementation and tests, but no production construction in `src`. Do not use it as the assistant's lifecycle source. If that pipeline becomes production-wired, it can feed the shared notification ingestion separately.
- There is no notification/event ledger or notification API/UI.
- No webhook verifier, Svix dependency, raw-body route, wallet history cursor, or periodic reconciliation worker exists in this branch. The Solana provider currently returns no transaction history, though the RPC abstraction can query signatures.
- Server routes and task registry are constructed in `src/server.ts` only when a database is configured. `onClose` drains tasks and closes the database; any scheduler must be stopped before the pool closes.

## Design implications

1. Make a durable notification row the user-facing source of truth. Webhook and reconciliation inputs must call the same idempotent event-ingestion path. Assistant lifecycle notifications must follow durable `conversation_transfer_attempts` transitions, keyed by attempt ID and canonical state; do not depend on process-local `FinancialTaskRegistry` events. Treat `wallet_operations` as a distinct adapter, not the assistant source.
2. Treat LiveKit `conversation_state_changed` as a low-latency invalidation signal, not the durable delivery mechanism. Add an authenticated, user-scoped feed API and refresh it over HTTP; retain conversation revision publication for active voice sessions.
3. Verify signed webhook bytes before parsing or persisting. Provider event IDs (plus provider/account scope) are dedupe keys. Reject invalid signatures and stale/replayed deliveries before side effects.
4. Poll reconciliation must be independently sufficient. Persist per-wallet cursors, use bounded pages and overlap/re-read around cursors, and make event insertion idempotent. Do not use balance deltas as the transaction identity.
5. Determine exact Privy event coverage for embedded Solana wallets and incoming transfers against the target app/dashboard before enabling a provider subscription. Public material located describes Svix verification, while the server-wallet announcement describes transaction and incoming-fund webhooks for server wallets; this does not establish coverage for this app's embedded/user wallets. The signed webhook adapter can remain provider-neutral, but unsupported event classes must be recovered by RPC reconciliation.
6. Capture assistant attempt events transactionally before asynchronous notification processing. A post-commit in-process hook has a crash window and does not satisfy the intake's durable-notice acceptance; use an outbox row committed alongside the attempt status change and make event processing retryable.
7. Define RLS by table purpose: notification and outbox data is user-owned; webhook receipts and reconciliation cursor/lease state is system-owned and accessible only in anonymous service transactions. Applying a user-only policy to worker tables blocks ingestion.
8. Treat `uncertain` as a durable notification-worthy assistant status because dispatch may have succeeded; exclude `not_dispatched`, which returns to `previewed` and remains retryable with an explicit conversation response.

## Options considered

| Option | Benefit | Cost | Decision |
|---|---|---|---|
| LiveKit-only revision signals | Reuses the existing path | Not durable; requires an active room and state polling | Reject as notification store |
| Webhook-only notifications | Low latency and simple ingress | Missed deliveries/provider scope gaps can lose events | Reject; D-5 requires reconciliation |
| Durable inbox + signed webhook + cursor reconciliation + LiveKit invalidation | Durable, recoverable, visible outside voice, and low latency when connected | Adds migration, API, scheduler, provider adapter, and UI | Recommend |

## Vendor evidence and unresolved capability check

- Privy documents Svix signature verification and signed headers for webhook deliveries: [Privy webhook verification](https://docs.privy.io/guide/server/webhooks/verify).
- Svix receiving guidance states its libraries reject timestamps more than five minutes in the past or future; use a 300-second boundary in the verifier contract and tests, and require synchronized server time: [Svix webhook verification guide](https://www.svix.com/guides/receiving/receive-webhooks-with-python/).
- Privy's official server-wallet announcement describes transaction-status and incoming-funds webhooks for server wallets; that is not evidence that the same event contract applies to this project's embedded user wallets: [Privy server wallets](https://privy.dev/blog/introducing-server-wallets).
- Before enabling live delivery, verify with Privy's current product docs/dashboard or test tenant which transaction and deposit event types apply to this app's embedded Solana wallets, their finality semantics, replay window, and endpoint configuration. Keep reconciliation as the correctness path if any class is absent.

## Sources inspected

`src/server.ts`; `src/conversations/financial-task-registry.ts`; `src/livekit/worker.ts`; `src/livekit/revision-publisher.ts`; `src/wallet/solana-devnet-provider.ts`; `src/wallet/transfer-pipeline.ts`; `src/db/migrations/006_embedded_wallets.sql`; `apps/nana-wallet/src/features/agent/useConversationState.ts`; `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts`; frontend wallet and agent screens; package manifests; migration and integration-test conventions.

Assistant transfer persistence was verified in `src/conversations/service.ts`, `src/conversations/postgres-repository.ts`, and `src/db/migrations/002_conversations.sql`. `WalletTransferPipeline` has no production construction under `src` in this branch; its current references are its definition and tests.
