# Apply Progress — slice3-grant-execution

## Phase 1+2 — Coverage classifier (completed 2026-10-05)

### RED evidence (before implementation)

`node_modules/.bin/vitest run tests/unit/grant-coverage.test.ts`:

```
Error: Cannot find module '../../src/conversations/grant-coverage.js'
       imported from tests/unit/grant-coverage.test.ts
Test Files  1 failed (1)
Tests  no tests
```

### GREEN evidence (after implementation)

| Check | Command | Result |
| --- | --- | --- |
| Focused unit suites | `vitest run tests/unit/grant-coverage.test.ts tests/unit/grants-engine.test.ts` | 2 files passed, **42/42 tests** (26 coverage + 16 engine) |
| Typecheck | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | clean (`--max-warnings=0`) |
| Whitespace | `git diff --check` | exit 0 |

### Files

- `src/conversations/grant-coverage.ts` (new) — pure static pre-filter `classifyGrantCoverage`.
- `tests/unit/grant-coverage.test.ts` (new) — 26 RED-first cases.
- `openspec/changes/slice3-grant-execution/tasks.md` — checkboxes 1.1–1.5, 2.1–2.3 → `[x]` (wording unchanged, 511 words ≤ 530 cap).

### Contract decisions locked in Phase 1+2

1. **Units (AD-5)**: SOL `0.01` → exactly `10000000` lamports; +1 lamport degrades `per_transfer_cap_exceeded`; unknown token / missing decimals → `units_unknown`; non-integral → `units_non_integral`; malformed/non-positive → `units_invalid`. String/`BigInt` only, no floats, no clamping.
2. **Eligibility (AD-3)**: `origin` is a server-owned discriminator — `model_tool` or any unknown value → `origin_ineligible`. `intentBoundToOriginalText` is an **explicit required server-computed boolean**; missing/false → `intent_not_bound`; never inferred from origin or field presence; `intentAmbiguous` also degrades closed. Phase 3 must prove the conversation service sets both from the authenticated original turn/transcript only (tool args cannot set them).
3. **D-2**: `walletId` is required on the request; exact identity comparison — a grant bound to another wallet is never a candidate.
4. **Q1 timestamp rule**: a candidate with `createdAt > request.now` is excluded (later grants never auto-execute older previews).
5. **Q3 ordering**: per-transfer cap ↑ → cumulative cap ↑ → earliest expiry → stable grant id, over validated rows only.
6. **Fail-closed robustness**: malformed cap strings (incl. hex `0x12` — `parseCap` enforces `/^\d+$/` before BigInt) are dropped **before** sorting (strict total-order comparator, no sentinel); a throwing `tokenDecimals` lookup → `units_unknown`; classification never throws.
7. **Sibling fallback**: `policy_not_ready` is remembered non-blocking — a policy-less stale grant never blocks a valid ready sibling; the reason surfaces only when nothing else covers.
8. **Structural invariant (AD-2)**: the module accepts no DB client, consumption reader, or window total; the cumulative window belongs exclusively to the atomic ledger claim (Phase 4).

### Next

Phase 3 — conversation service gate RED/GREEN (covered ⇒ `sent` without confirmation; degraded ⇒ preview + copy; optional deps wiring; contract zero-delta assertion).

## Phase 3 — Conversation gate (completed 2026-10-05)

### RED evidence (before service wiring)

`vitest run tests/unit/conversation-grant-gate.test.ts` — covered case failed with
`expected 'confirmation_required' to be 'sent'` while both controls (degraded gate,
absent dependency) passed with `confirmation_required` — an invalid-RED round was
corrected first: pre-seeded pending transfer and wrong network/token fixture made
all 3 cases fail with generic `error`; fixture repaired to the existing EVM USDT
baseline so only the covered case failed for the intended missing behavior.

### GREEN evidence

| Check | Command | Result |
| --- | --- | --- |
| Focused suites (gate + service + factory + classifier + engine) | `vitest run` (5 files) | **71/71** |
| Full unit gate suite | grant-gate file | 4/4 (covered, financial-task terminal `sent`, degraded, absent-dep) |
| Typecheck | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | clean |
| Whitespace | `git diff --check` | exit 0 |

### Implementation

- `src/conversations/service.ts`: optional `grantGate` dependency; consulted ONLY in
  `handleTurnStream` after a fresh `confirmation_required` preview — never from
  `persistNativePreview`/`previewTransfer` (model-tool paths; regression-asserted).
  Covered ⇒ internal `resolveDecision({decision:"confirm", authorizedBy:"delegated_grant",
  waitForFinancialTask:true})` reusing the single-winner attempt claim +
  `runFinancialTransfer`; terminal `sent` returned in-turn. `authorizedBy:"delegated_grant"`
  skips the fabricated user "confirm" message (asserted). Gate absence/exception ⇒ null ⇒
  unchanged flow (fail closed).
- `src/conversations/grant-gate.ts` (new): concrete factory gate — parses the original text
  server-side, requires exact action/amount/token/recipient match against the server-owned
  pending preview (model cannot alter amount/destination), resolves wallet via
  `DelegatedGrantService.resolveWalletId(userId,"solana")` (D-2), decimals via
  `provider.listTokens("solana-devnet")`, classifies via `classifyGrantCoverage`. No
  consumption reads (AD-2); every error/mismatch ⇒ null (fail closed); injected clock.
- `src/server.ts`: gate wired in the database block only when `walletForUser` exists;
  absent seam ⇒ no gate ⇒ today's behavior.
- Contract: zero HTTP contract delta (existing `sent` shape reused); `api-types.ts` mirror
  untouched — mirror obligation remains the phase-6 no-op assertion.

### Tests added

`tests/unit/conversation-grant-gate.test.ts` (4), `tests/unit/grant-gate-factory.test.ts` (8:
exact hit, unknown token, amount mismatch, recipient mismatch, ambiguous intent, unsupported
network, no candidates, ledger failure).

### Next

Phase 4 — atomic claim integration (DB): claimConsumption authority, races, replay two-gate
semantics, revoke/expiry between preview and execution, window rejection.

### Environment note (2026-10-05)

- `delegated-grants-consumption` against `dgc-test-db-1`
  (`postgresql://postgres@127.0.0.1:55499/wdk_agent`): **14/14 pass**
  (verified independently by Ramiro). An earlier "14 fails" reading came from
  a WRONG `DATABASE_URL` (database=postgres, wrong port) — not evidence of
  failure; do not cite it.
- Fresh migrated DB ready for Phase 4:
  `postgresql://postgres@127.0.0.1:55501/wdk_agent?options=-csearch_path%3Dpublic,extensions`
  (extensions schema present, recipient_app granted).
- Fresh full suite result (run by Ramiro): **10 failing / 836 passing /
  10 skipped**. Failures are `api-contacts` timeouts, extension-schema
  permission issues (predating this change's grant), and sentinel config;
  comparison against CI/main pending before attributing any of them to this
  change.
- Targeted conversation subset on the fresh DB
  (`api-conversation-service`, `api-conversation-resolution`,
  `conversation-preview-claim-race`, `voice-touch-decision-race`):
  **4 files / 6 tests pass**. The `api-contacts` rerun that hung >2 min with
  no active DB query was stopped rather than waiting for timeouts.

## Phase 4 — Atomic ledger claim (completed 2026-10-05)

### RED evidence (before grantLedger wiring)

`DATABASE_URL=:55501/wdk_agent vitest run tests/integration/delegated-grant-execution.test.ts`:
3 cases failed with `AssertionError: expected false to be true` — the real
`grants.claimConsumption` callback was never invoked by the service. Two harness
defects were corrected first (pre-seeded attempt, non-durable previewId in the
spy repository) so the RED was specifically the missing claim integration:
`saveSnapshot` now models the durable repository behavior (new pendingTransfer
creates `conversation_transfer_attempts` and attaches the durable attempt id),
and the replay case pre-claims `grant-exec:{userId}:{predeterminedAttemptId}`.

### GREEN evidence

| Check | Command | Result |
| --- | --- | --- |
| Integration ordering suite | `vitest run tests/integration/delegated-grant-execution.test.ts` (DATABASE_URL :55501/wdk_agent) | **3/3** |
| Typecheck / lint | `npm run typecheck` / `npm run lint` | clean |

### Implementation

- `src/conversations/service.ts`: `grantLedger.claim` dependency. AD-6 sequencing
  on the delegated-grant path: **claimConsumption BEFORE claimPendingTransfer** —
  missing context (grantId/amountSmallestUnits), missing ledger, rejection, or any
  ledger error ⇒ degrade closed with NO attempt claim and NO broadcast. Key =
  `grant-exec:{userId}:{persisted attemptId}`; `amountSmallestUnits` exact from
  the classifier. Replay returns the same budget claim but never authorizes a
  broadcast by itself — the broadcast still requires winning the single-winner
  attempt claim. Explicit user confirms keep the existing ordering.
- `src/conversations/grant-gate.ts`: covered decision now carries
  `amountSmallestUnits` (exact smallest-units from `CoverageDecision`).
- `src/server.ts`: `grantLedger.claim` wired from the same `grants` service
  (`grants.claimConsumption`), conditional on `walletForUser` like the gate.

### Tests

`tests/integration/delegated-grant-execution.test.ts` (3, real Postgres):
claim-commits-before-attempt-and-broadcast (event order: ledger:consumed <
attempt:broadcasting < submitted); real rejected claim (unbound grant ⇒
`policy_not_ready`) never claims the attempt nor broadcasts; same-key replay
(no second audit row) still requires winning `claimPendingTransfer`.

### Next

4.4 remainder: ordered candidate fallback + audited degradation; then Phase 5
(typed/voice parity + E2E).

## Phase 4.4 — Ordered candidate fallback (completed 2026-10-05)

### Implementation (design AD-4/AD-6/AD-8 binding)

- `src/conversations/grant-coverage.ts`: `CoverageDecision.covered` now carries
  `orderedCandidates` — ALL statically eligible candidates in Q3 order
  (per-transfer cap → cumulative cap → expiry → stable id), computed from the
  sorted valid candidate list. Unit suite 26/26 (covered assertions now
  `toMatchObject`; malformed-cumulative and policy-less-sibling cases updated
  for the new shape).
- `src/conversations/grant-gate.ts`: `GrantGateDecision.orderedCandidates`
  propagated from the classifier result.
- `src/conversations/service.ts`: sequential claim loop over
  `orderedCandidates` — same key `grant-exec:{userId}:{attemptId}` per
  candidate; first `consumed: true` wins and proceeds to the attempt gate;
  each rejection (revoked/expired/window/budget) falls back to the next and is
  audited by the ledger; a ledger error or exhausted list degrades closed with
  no attempt claim and no broadcast. `used` rows exist only for the winning
  claim. Explicit user-confirm path unchanged.

### Evidence

| Check | Command | Result |
| --- | --- | --- |
| Classifier unit | `vitest run tests/unit/grant-coverage.test.ts` | 26/26 |
| Claim ordering (real DB :55501) | `vitest run tests/integration/delegated-grant-execution.test.ts` | 3/3 |
| Candidate fallback (real DB :55501) | `vitest run tests/integration/delegated-grant-candidates.test.ts` | 2/2 (service iterates: narrow rejected+audited → fallback consumed → single broadcast; all-rejected ⇒ no broadcasting, confirmation_required, both rejections audited) |
| Typecheck / lint | `npm run typecheck` / `npm run lint` | clean |

Harness notes (test-only, production Q1 rule untouched): test classifier `now`
pinned +5s to absorb Postgres/process clock skew on `createdAt`; gate stub
delivers real `classifyGrantCoverage` output so the service iteration runs
against the real ledger; pre-claim exhausts the narrow grant's budget before
the flow. Diagnostic console.logs removed.

## Phases 5+6 — Parity, model-origin exclusion, E2E, verification (2026-10-05)

### Phase 5 evidence

- **Typed/voice parity + LiveKit layer** (`tests/unit/livekit/grant-parity.test.ts`, 3):
  transcript funnels through the SAME `handleTurnStream` seam (identical gate contract);
  the RoomConversation surface exposes no grant capability; degraded confirm/cancel
  still routes through `resolveDecision`.
- **Model-origin exclusion** (`tests/e2e/grant-gate-model-origin.e2e.test.ts`, 2):
  tool `persistNativePreview` (dry-run, `preview:true` output) never consults gate/ledger
  nor broadcasts; tool preview + EXPLICIT user confirm broadcasts exactly once with gate/
  ledger uninvolved.
- **Covered E2E both entry points** (`tests/e2e/grant-gate-entries.e2e.test.ts`, 1):
  one service + one shared durable in-memory repository; typed turn and voice transcript
  (signed Ed25519 binding) each skip confirmation via gate+claim+attempt-win; terminal
  `sent`; D-7 multi-execution (two distinct durable attempts consumed the same grant).
- Focused suites: 6 files / 45 tests (updated for the Fase-4 contract: gate decisions
  carry `grantId`/`amountSmallestUnits`/`orderedCandidates`; service requires a consumed
  `grantLedger.claim` before skipping).

### Phase 6 verification (all exit 0)

| Check | Result |
| --- | --- |
| `npm run lint` (--max-warnings=0) | clean |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| Unit suite | 84 files / 657 passed, 1 skipped (exit 0) |
| DB grants suite (:55501) | 5 files / 35 passed (exit 0) |
| Focused parity + E2E suite | 6 files / 45 passed (exit 0) |
| Full integration suite (:55501) | 37 files / 183 passed / 2 skipped / 6 failed |
| Contract mirrors | zero delta (existing `sent` shape reused); `api-types.ts` untouched |
| Scope check | no provider, LiveKit tool surface, or `transfer-pipeline.ts` changes in the diff |

### Bounded-review fix (request-time classification, AD-2/Q1)

`createGrantGate` previously captured `clock.now()` AFTER ledger/provider lookups; a
grant created during slow lookups could cover an older request. Fixed: `handleTurnStream`
captures `requestAt` at entry (before the first await) and passes it as a REQUIRED
`GrantGateInput.requestAt`; the classifier's `now` is that captured instant. Regressions
added for a grant created after `requestAt` (never a candidate) and a clock that advances
during the turn (no eligibility change).

### Full integration baseline comparison

The six full-integration failures reproduce unchanged on `origin/main` at
`c4d56c3` with the same local database and environment, in the same four files:
two `users-db` sentinel tests (missing `DEMO_USER_ID`), one durable
`api-conversations` create/read test (500), one `contacts-cross-user` timeout,
and two `api-contacts` timeouts. The four-file baseline subset on `origin/main`
also reports 6 failed / 10 passed. The delegated-grant database tests remain
green in isolation (5 files / 35 passed).
