# Tasks: Delegated Grant Core (Slice 1)

## Phase 1 — Database foundation

- [ ] 1.1 Write migration `src/db/migrations/008_delegated_grants.sql` with
      `delegated_grants` (scoped grant model per design.md) and append-only
      `grant_audit_log`, RLS via `app.user_id` matching existing migrations.
- [ ] 1.2 Write the Supabase mirror `supabase/migrations/20260901000700_delegated_grants.sql`.
- [ ] 1.3 Extend migration apply path (CI applies `supabase/migrations/*.sql`;
      verify local mirror parity) and add schema tests.

## Phase 2 — Grant engine (pure core)

- [ ] 2.1 Implement `src/wallet/grants/engine.ts`: `evaluateGrant` pure
      function (action, per-transfer cap, cumulative cap, window, expiration,
      revocation, recipient allowlist) with injected clock.
- [ ] 2.2 Implement `src/wallet/grants/validators.ts`: chain plug-in interface +
      `solana` base58 validator; unregistered chains fail closed.
- [ ] 2.3 Unit tests: covered / cap-exceeded / expired / revoked / allowlist /
      validator-unavailable / degradation mapping (red → green per rule).

## Phase 3 — Consumption & audit (PostgreSQL-backed)

- [ ] 3.1 Implement `src/wallet/grants/consumption.ts`: rolling-window
      aggregation over `grant_audit_log` + atomic consumption append inside the
      execution transaction (no in-memory counters).
- [ ] 3.2 Integration tests with real DB (`DATABASE_URL`): window boundaries,
      concurrent cap race resolved at DB level, idempotency-key reuse does not
      double-consume.
- [ ] 3.3 Implement audit append helpers (created/used/rejected/revoked/expired/
      policy_synced/policy_sync_failed) with append-only enforcement test.

## Phase 4 — Privy policy sync (hybrid D-4)

- [ ] 4.1 Implement `src/wallet/grants/privy-policy-sync.ts`: create/rotate/
      revoke the signer's Solana policy from ledger state; idempotent; fail
      closed on sync error (grant stays non-active).
- [ ] 4.2 Unit tests with a fake policy client: sync success → `policy_synced`;
      failure → `policy_sync_failed` + non-active grant; rotation serialization.

## Phase 5 — HTTP lifecycle endpoints & contract

- [ ] 5.1 Add zod schemas to `src/contracts/http.ts` (create/list/revoke grant).
- [ ] 5.2 Implement `src/api/grants.ts` (POST /v1/grants, GET /v1/grants,
      POST /v1/grants/:id/revoke) using `dependencies.resolveUserId`; register in
      `src/server.ts`.
- [ ] 5.3 Unit tests: 401 without identity, happy paths, validation errors,
      revocation effect.
- [ ] 5.4 Mirror contract types in `apps/nana-wallet/src/lib/api-types.ts`
      (same PR rule) and update `src/lib/api.ts` client methods.

## Phase 6 — Frontend grants surface

- [ ] 6.1 Grants list + create/revoke UI module under
      `apps/nana-wallet/src/features/wallet/` (authenticated HTTP only).
- [ ] 6.2 Colocated component tests (Vitest + Testing Library; MSW handlers for
      /v1/grants).

## Phase 7 — Verification

- [ ] 7.1 Backend suite green with DB up (`docker compose up -d db`):
      `npm run lint && npm run typecheck && npm test`.
- [ ] 7.2 Frontend suite green: `npm run lint && npm run typecheck && npm test`
      in `apps/nana-wallet/`.
- [ ] 7.3 Manual: revoke takes effect before next execution attempt; failed
      policy sync blocks covered execution (fail-closed); degradation path is
      user-observable (preview + confirmation) and never a hard conversation
      error.
- [ ] 7.4 Confirm demo boundary unchanged: `WDK_TOOLS_SOURCE=fixture` default;
      no live keys touched; no voice path mutates grants.
