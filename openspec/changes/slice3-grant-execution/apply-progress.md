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
