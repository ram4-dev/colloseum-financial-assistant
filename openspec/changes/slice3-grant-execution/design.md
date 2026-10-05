# Design: slice3-grant-execution

Binding: spec (45 scenarios), proposal (Q1–Q4, D-2/3/4/7), exploration §2/§3/§6/§7. Line refs spot-verified.

## Context

Grant engine unwired (`DelegatedGrantService` at `src/server.ts:191`, grant routes only). All confirmation sites funnel through `resolveDecision` (`src/conversations/service.ts:430`) → attempt claim (`:508`) → `runFinancialTransfer` (`:730`, honest `uncertain` wording `:823-841`). Exploration §7 names the seam.

## Architecture Decisions

**AD-1 Single seam, optional deps.** Optional grant deps on `WalletConversationDependencies`, wired from `server.ts:191`; absent ⇒ today's behavior byte-for-byte. *Rejected:* per-entry-point wiring (divergent text/voice).

**AD-2 Two-phase authority; two moments.** Pre-filter = static bounds only (lifecycle, expiry, per-transfer cap on converted units, allowlist, action/chain, wallet match, units integrity) — **no consumption read anywhere in the conversation path (structural invariant)**. It binds **explicit intent** first: exact amount + resolved recipient traceable to the authenticated original user turn/transcript via existing parsing/resolution; ambiguous/absent/unmatchable ⇒ degrade; tool arguments never backfill. `claimConsumption` (`consumption.ts:382-512`) is the sole execution authority: user-scoped tx + advisory lock re-checks state, DB-clock expiry, policy binding, caps, rolling window; claim + `used` audit commit together before broadcast. Request-time classification enforces Q1 (grant `created_at` after the original request turn ⇒ not a candidate); claim recheck guards TOCTOU. *Rejected:* `evaluateGrant` as authority; `consumedInWindow` with a raw client (returns 0).

**AD-3 Eligibility (model-tool exclusion).** Skip only when the shared service processes the authenticated original user turn/transcript (typed `handleTurn`; voice transcript `src/livekit/room-conversation.ts:195-217`). Model-produced tool previews (`send_token`/`previewTransfer`: `create-realtime-tools.ts:265-285`, `src/agent/livekit-adapter.ts:109-116`) stay preview + explicit-confirm — auto-skip would be model-delegable (violates D-3). Mechanism: server-decided preview-origin marker (user request vs model tool) on `previewTransfer`; classifier consults the marker, never tool payload; plus AD-2 intent binding. Non-covered previews unchanged. Slice 4 keeps voice-confirmation UX. *Rejected:* eligibility from tool arguments.

**AD-4 Selection (Q3).** Order: per-transfer cap ↑ → cumulative cap ↑ → earliest expiry → stable grant id. Iterate all static-eligible candidates; any claim rejection ⇒ next candidate; degrade when exhausted. Wrong `wallet_id` ⇒ never a candidate. No model/client parameter exists. *Rejected:* single top-ranked attempt (strands payable requests).

**AD-5 Units.** Decimals from provider `listTokens(network)` (`provider.ts:13,66-67`; SOL = 9, `solana-devnet-provider.ts:322`). Human decimal string → integer smallest units via string/`BigInt` math only; unknown token / missing decimals / non-integral ⇒ degrade closed. No clamping; ceiling acts via ordinary coverage comparison. *Rejected:* hardcoded decimal tables.

**AD-6 Idempotency: two independent single-winner gates.** Key `grant-exec:{userId}:{attemptId}` from the persisted `conversation_transfer_attempts.id`; `grant_claim_ledger` unique key + replay branch (`consumption.ts:395-409`) enforce budget idempotency. A `claimConsumption` replay returns the same budget claim with no second consumption/audit — it NEVER implies a completed transfer. Any broadcast must also win the single-winner `claimPendingTransfer` transition (`previewed → broadcasting`, `postgres-repository.ts:364-395`); a `broadcasting`/terminal attempt cannot broadcast twice. Crash after budget claim but before attempt claim ⇒ same-key retry is safe and proceeds only if the attempt transition is won — retries are never stranded by a blanket "replay ⇒ no broadcast". *Rejected:* session-counter keys; parallel idempotency table.

**AD-7 Covered flow, narration, contract.** Covered ⇒ skip confirmation branch, reuse the same `runFinancialTransfer` boundary (re-validation untouched). Honest narration; `uncertain` wording verbatim; no cancel window. Result = existing `sent` shape (`http.ts:119`) ⇒ **zero contract delta**; mirror = no-op assertion that both contract files agree; unforeseen delta ships mirrored same PR. Never use the stale client `confirmTransfer` route. *Rejected:* new `auto_executed` variant.

**AD-8 Closed degradation (Q4).** Every non-covered outcome (conversion failure, no candidate, claims rejected, engine/ledger/DB/unknown errors, ineligibility) ⇒ copy "the active authorization did not cover this request" + standard preview/confirm flow. Reason codes internal; no budget consumed; no `used` row (rejected-claim audit rows allowed); never a hard error.

**AD-9 Policy readiness & drift.** Ledger binding check gates (`policy_not_ready`); broadcast relies on Privy enclave enforcement. No new execution-time readback. Ledger-vs-Privy drift at execution = accepted risk.

## Flow

classify (intent bound, static only) → ordered candidates → claim (+ `used` committed) → skip confirmation → `claimPendingTransfer` single-winner → broadcast/finality via unchanged `runFinancialTransfer` → `sent` + honest narration. Degraded: not covered ⇒ copy + `confirmation_required` ⇒ existing confirm/cancel. Race: unique key + advisory lock ⇒ one winner; loser tries next candidate or degrades.

## Data/State

No schema changes; all four tables unchanged. New in-process only: preview-origin marker (OPEN-1: persist only if cross-process recomputation is proven), optional deps.

## Testing (Strict TDD)

`strict_tdd: false` overridden by mandate. RED → GREEN → TRIANGULATE → REFACTOR; `npm test` + `npm run typecheck`. RED baseline: no test asserts covered-skip today. Tiers: (1) unit — classification vs every degrade reason; units (unknown/missing decimals, non-integral, SOL ceiling ±1); Q3 ordering; eligibility (tool-origin exclusion, timestamp rule, intent binding); structural no-consumption. (2) unit gate — covered ⇒ `sent`; degraded ⇒ preview + copy; exception ⇒ degrade. (3) integration DB (pgvector up mandatory; pattern `tests/integration/delegated-grants-consumption.test.ts:19-20`) — claim races, replay + two-gate semantics incl. crash-retry, revocation/expiry between preview and execution, window rejection, no `consumedInWindow` in `src/conversations/*`. (4) parity — typed vs voice transcript identical; tool surface preview-only. (5) E2E — covered path typed + voice, fixture default, no live credentials.
