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
