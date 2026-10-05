# Tasks: Durable wallet and assistant notifications

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 450–650 |
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
| 1 | Durable feed, event ingestion, reconciliation, and UI | Slice 5 PR | `npm test -- tests/unit/notifications tests/integration/notifications` | `npm run test:e2e:browser` with fake provider/RPC; no real funds | Disable ingress/reconciler and hide feed; additive tables remain |

## Phase 1: RED contracts

- [ ] 1.1 Add RED tests for raw-byte signature failure, timestamp/replay rejection, provider identity-to-wallet ownership, and no side effects on invalid webhook.
- [ ] 1.2 Add RED tests for canonical event normalization, `conversation_transfer_attempts` state notification/idempotency, webhook/poll overlap dedupe, per-user RLS, and safe projection.
- [ ] 1.3 Add RED tests for cursor overlap, page failure without cursor advance, concurrent wallet reconciliation exclusion, and RPC rate-limit backoff.
- [ ] 1.4 Add RED frontend tests for empty/unread/read feed, focus refresh, visible-page polling, and LiveKit invalidation refresh.

## Phase 2: Durable backend

- [ ] 2.1 Create additive migration for notifications, webhook receipts, reconciliation cursors/leases, indexes, grants, and RLS.
- [ ] 2.2 Implement one idempotent user/wallet-scoped ingestion service and safe display projection.
- [ ] 2.3 Implement authenticated paginated feed and mark-read routes; add isolated raw-body webhook verification and scoped receipt dedupe.
- [ ] 2.4 Add bounded Solana history pages, overlap-safe cursor persistence, per-wallet exclusion, backoff, startup scheduling, and shutdown cancellation.
- [ ] 2.5 Emit notification-worthy assistant transitions from committed `conversation_transfer_attempts` updates, keyed by attempt ID + state; publish conversation invalidation only after notification commit. Keep `wallet_operations` a separate optional adapter unless production wiring is added.

## Phase 3: Frontend and integration

- [ ] 3.1 Add typed feed/read API client, notification query, inbox surface, and unread/read affordance.
- [ ] 3.2 Refresh the feed on focus, bounded visibility polling, and existing LiveKit conversation revision signals.
- [ ] 3.3 Add fake-provider/RPC Fastify and browser E2E for assistant transfer states and recovered inbound activity without a page reload.

## Phase 4: Verify and deliver

- [ ] 4.1 Run backend lint, typecheck, unit/integration tests, build, migration/RLS tests, and browser E2E; run frontend lint/typecheck/tests/build.
- [ ] 4.2 Verify exact Privy embedded-Solana event coverage before configuring live webhook subscriptions; document gaps and prove polling recovery.
- [ ] 4.3 Record SDD verification, commit by phase, push branch, open one Slice 5 PR, and hand exact SHA to Hermes for testing.
