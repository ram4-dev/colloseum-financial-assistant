# Wallet event ingestion

## Purpose

Normalize signed provider deliveries, persisted operation transitions, and chain reconciliation into one idempotent notification path.

## Requirements

### Requirement: Verify and deduplicate signed provider webhooks

The system MUST verify provider webhook signatures over the exact raw request bytes before trusting or persisting payload data. It MUST reject invalid signatures and duplicate delivery IDs without side effects. Provider wallet identity MUST be resolved to a locally enrolled wallet and owner; payload-supplied user IDs MUST NOT determine ownership.

#### Scenario: Invalid signature
- **GIVEN** a webhook request with an invalid signature or timestamp
- **WHEN** the endpoint receives it
- **THEN** it is rejected before event persistence, notification insertion, or fan-out.

#### Scenario: Duplicate provider delivery
- **GIVEN** a valid provider event already accepted with the same scoped delivery ID
- **WHEN** the provider retries it
- **THEN** the endpoint acknowledges safely without creating another event or notification.

### Requirement: Reconcile missed or unsupported provider events

The system MUST reconcile supported wallet activity using persisted per-wallet/network cursors and bounded pages. Reconciliation MUST tolerate overlap and webhook/poll races through canonical chain-event deduplication, and MUST NOT infer transaction identity from balance changes. Cursor progress MUST NOT skip an event when page processing or persistence fails.

#### Scenario: Webhook is missed
- **GIVEN** a confirmed wallet event is absent from webhook ingestion
- **WHEN** reconciliation reaches its chain signature
- **THEN** the event is normalized and a single canonical notification is persisted.

#### Scenario: Webhook and poll overlap
- **GIVEN** the same chain event arrives by webhook and reconciliation
- **WHEN** both paths ingest it concurrently or sequentially
- **THEN** exactly one canonical notification exists and the cursor advances only after durable processing.

#### Scenario: Provider lacks event coverage
- **GIVEN** the configured provider does not deliver a supported event class for embedded Solana wallets
- **WHEN** the service runs
- **THEN** reconciliation remains the complete recovery path and unsupported webhook types are not treated as coverage.

### Requirement: Publish transient refresh only after durable insert

The system MUST insert the canonical notification before publishing any LiveKit conversation revision invalidation. Failure of transient fan-out MUST NOT roll back or hide a committed notification.

#### Scenario: LiveKit publish fails
- **GIVEN** a notification is committed for an active conversation
- **WHEN** LiveKit is unavailable
- **THEN** the durable feed remains readable and the client can discover it through HTTP refresh.
