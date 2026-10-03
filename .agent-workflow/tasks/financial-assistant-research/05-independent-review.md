# Independent Adversarial Review — 04-structure-outline.md

- Reviewed file: `.agent-workflow/tasks/financial-assistant-research/04-structure-outline.md`
- Reviewed SHA-256: `6546afc4943d0d2d83573edffef77284d3b4ed522289399070cbe2ef780c5375` (verified before reading; matches the byte content on disk).
- Review date: 2026-10-03. Reviewer: independent, no repo or file modifications (this report is the only write).
- Inputs: the outline itself + local verification against `/Users/ramiro/Desktop/projects/personales/aleph-hackathon` @ `99ad96b`.
- No external research was performed in this review; every external-vendor claim is quoted from the outline and carries its own REVALIDAR flag.

## Verdict

**APPROVED WITH MINOR RISKS (PASS with minor risks).** No critical blockers found. The outline is consistent with the validated user agreements (delegated bounded rules; grant-covered executions skip re-confirmation; out-of-grant inline transactions keep the double-confirmation flow; Solana-first approved for Colloseum). Wallet-class decision (§2.2) and session-key mechanism are correctly kept open and gated.

## Verified local repo claims (aleph-hackathon @ 99ad96b)

| Outline claim | Verified | Evidence |
| --- | --- | --- |
| HEAD `99ad96b`, voice Realtime LiveKit + OpenAI, durable conversation service, `WalletProvider` seam | ✅ | repo root, `src/livekit/revision-publisher.ts`, `src/wallet/provider.ts:39` (`interface WalletProvider`) |
| `signer_grants` exists (fixture-only, experimental) | ✅ | `supabase/migrations/20260901000500_embedded_wallets.sql:26` (states: pending/active/revoking/revoked/unavailable, RLS enforced), `src/wallet/embedded.ts:590-948`, `src/wallet/transfer-pipeline.ts:474` |
| `WalletTransferPipeline` fixture-first | ✅ | `src/wallet/transfer-pipeline.ts:249-262` (`fixture-first signing and broadcast pipeline`, `privy.mode !== "fixture"`) |
| Idempotency pattern `previewId`/`idempotency_key` exists | ✅ | `src/wallet/transfer-pipeline.ts:34,505-520`; `src/wallet/circle-arc-provider.ts:210` |
| preview → confirm → broadcast → finality, `uncertain` reconciliation | ✅ | `src/wallet/circle-arc-provider.ts:210-262` (`not_dispatched`/`uncertain`), `src/wallet/agent-tools.ts:117`, `src/wallet/fixture-provider.ts:21,84` |
| `send_token` / `confirm_transfer` tools exist | ✅ | `src/agent/wallet-agent.ts`, `src/agent/definition.ts` |
| Multi-wallet / swaps / notifications absent (0 hits for swap/notif/webhook in `src/`) | ✅ | grep of `src/` returned 0 matches |
| EVM code stays as pattern reference, not base to extend | consistent | EVM-era files present but Solana-first explicitly excludes extending them |

## Consistency with approved agreements

- Grant-covered execution without re-confirmation → Slice 3 (§4) — consistent.
- Out-of-grant inline transaction → preview + double confirmation (Slices 4, 7) — consistent.
- Exceeded/expired/revoked grant degrades closed to preview+confirm (§3.3, Slice 1 checks) — consistent.
- Solana-first: registered as decided (§2.1), no per-slice chain gate remains (§7 note verified in doc) — consistent.
- Voice-based grant granting remains forbidden (§1, §2.3 pending ratification of the authenticated-signature channel) — consistent; note the dependency is correctly placed in Slice 1 (authenticated endpoint, client signature).

## Slice sequencing / dependency / test review

- Slice 1 (grant core, chain-agnostic) → Slice 2 (Solana provider) → Slice 3 (authorized execution) → Slice 4 (voice confirmation) is a sound hard chain; hard-block wording ("no empieza sin su dependencia") is explicit.
- Each slice has a stated observable outcome, dependency list, and unit/integration/build/E2E/manual checks. No slice lacks a result or tests.
- Slice 5 parallelizable with Slice 3 with a fixed event contract — acceptable; Slice 5 correctly depends on Slice 2.
- Conditional slices 6/7 correctly gated on wallet-class decision and vendor REVALIDAR.

## Prioritized findings (no critical blockers)

### F1 — Control: testnet vs devnet inconsistency (Medium)

Slice 2 result says "Solana devnet/testnet" and integration checks say "testnet real (or deterministic fixture + manual smoke testnet)", but E2E says "devnet Solana". The outline never fixes the network of record for the hackathon demo.

- Ref: 04-structure-outline.md, Slice 2 lines: Result, Integration check, E2E check.
- Risk: split test evidence across two networks; finality/explorer checks may be validated on a network the demo doesn't use; fee/finality models differ subtly.
- Required action (outline-level, not implementation): before Slice 2 starts, fix one network of record (recommended: devnet for the demo, testnet only if a provider constraint forces it) and name the network explicitly in the Slice 2 result and E2E check.

### F2 — Control: devnet/testnet finality is a weak proxy for the fee/finality model (Medium)

"Espera de finalidad" and fee model are validated only against test networks. Solana testnet is a cluster primarily for network/validator testing and has had unstable fee-market conditions historically; devnet also has its own quirks. This does not block MVP (out of scope: mainnet/Arc production is explicitly excluded, §5), but any conclusion recorded as "verified fee/finality model" must be labeled testnet-only evidence.

- Ref: Slice 2 scope ("modelo propio de fees y finalidad"); §5 exclusion of production; §6.3 REVALIDAR blanket.
- Required action: label any fee/finality conclusion from Slice 2 as testnet/devnet-only, never as mainnet-ready.

### F3 — Control: Slice 3 notification dependency is intentionally loose (Low)

Slice 3 depends on "canal de notificación mínimo (puede empezar con evento de revisión interno y completarse en Slice 5)". Acceptable for sequencing, but §3.7 requires every execution to produce a user-observable event from day one. Slice 3's E2E must verify the user-visible aviso, not just an internal revision event.

- Ref: Slice 3 dependencies + §3.7.
- Required action: Slice 3 E2E explicitly asserts the user-observable aviso exists (even if the channel completes in Slice 5).

### F4 — Control: concurrency claim needs an on-chain-unique constraint, not just unit test (Low)

Slice 3's "doble ejecución concurrente del mismo grant (cap)" is tested at unit level; the repo pattern (`ON CONFLICT (idempotency_key) DO NOTHING`, unique constraint, atomic claim with `FOR UPDATE`) is the right mechanism and is cited as existing. Keep the unit test but require the integration check to exercise the DB-level unique-constraint path, not an in-memory counter.

- Ref: Slice 3 unit checks; repo `src/wallet/transfer-pipeline.ts:505-520`.
- Required action: Slice 3 integration check must exercise DB-level idempotency (unique-constraint path), not an in-memory cap.

### F5 — Minor: Slice 2 "REVALIDAR" is a dependency, not just a note (Low)

Slice 2 depends on the chosen wallet provider's Solana support/fees (REVALIDAR). This is flagged but not scheduled as a pre-Slice-2 gate task with an owner. Risk: Slice 2 starts on a provider whose Solana support is unverified.

- Required action: make provider Solana-support REVALIDAR an explicit exit-criterion of the pre-Slice-2 gate (ADR of Slice 1 or its own mini-gate).

### F6 — Minor: date-correction section is sound but relies on review-findings.md (Low)

§"Corrección de fechas" states 2026-10-03 verification of OpenAI/LiveKit "según `review-findings.md`". Not re-verified in this review (out of scope, no external research allowed); retained as labeled in the outline itself (tagged, per review instructions: **REVALIDAR** the 2026-10-03 claims if the hackathon timeline extends past the pricing/tool docs' volatility window).

- Required action: none for MVP; revalidate pricing/async-tools claims before implementation if timeline extends.

## Wallet assumptions needing a gate

1. **Wallet classes (§2.2)** — main open gate; correctly pending explicit user approval. Recommendation (embedded) is coherent with the approved policy. Gate before Slice 2.
2. **Session keys** — correctly treated as mechanism-to-choose, not existing (§0.2). The reviewer verified the existing `signer_grants` table is real but fixture-experimental; the outline does not overstate it. Gate: Slice 1 ADR.
3. **Provider Solana support** (Privy or other) — REVALIDAR before Slice 2; flagged in the outline; per F5 make it a hard gate.
4. **Grant covered = one bounded action** — outline is consistent that a grant authorizes a bounded action; concurrency cap relies on the existing DB idempotency pattern (F4).

## Disposition proposal

- Keep the outline as the planning baseline. Do not modify file 04 in this review.
- Record F1 (single network of record) and F5 (provider Solana-support as hard pre-Slice-2 gate) as required outline amendments at the next outline touch (not a blocker to keeping the baseline).
- F2–F4 become explicit check amendments in slice-level specs when written.
- Next user gate: wallet classes (§2.2) + outline content approval, as the outline itself already states (§7).

---

# Second Independent Pass — post-amendment review

- Reviewed SHA-256 (second pass): `591f205ffc631fa9557f0465e4a6586831e19f76002d606b5efe219df0f8ce05` (verified against bytes on disk before reading; 312 lines).
- First-pass SHA-256: `6546afc4943d0d2d83573edffef77284d3b4ed522289399070cbe2ef780c5375`.
- Scope: full re-read of 04; verification of F1–F5 dispositions; agreement coherence (Solana-first, grant-scope without re-confirmation, inline/unauthorized double confirmation); cross-check that `03-design-discussion.md` and `review-findings.md` no longer claim the network decision is pending.

## Finding dispositions (second pass)

### F1 — Network of record: APPLIED in Slice 2 ✅ (one residual, see F1-R)

Slice 2 now names **Solana devnet** consistently in all four places: result observable ("una transferencia de prueba en Solana devnet", line 155), integration check ("proveedor contra Solana devnet", line 163), manual smoke ("devnet", line 164), and E2E ("transferencia de prueba completa en Solana devnet", line 166). The former "testnet real" wording is gone from Slice 2.

**F1-R (residual, minor):** Slice 7 E2E still says "E2E de compra en testnet" (line 270). Slice 7 is conditional and last-priority, so this does not block the baseline, but it contradicts the devnet network-of-record now fixed by Slice 2. Required at next outline touch: change Slice 7's E2E/manual wording to devnet (or explicitly justify a different network for swaps).

### F2 — Devnet fee/finality is not mainnet evidence: APPLIED ✅

New closing line in Slice 2 (line 173): "Las conclusiones de fees y finalidad validadas en devnet describen solo ese entorno de prueba; no demuestran preparación para mainnet." Coheres with §5 (Arc mainnet / production out of scope).

### F3 — E2E asserts user-visible aviso: APPLIED ✅

Slice 3 E2E now reads "ambos auditados y con un aviso visible para el usuario" (line ~208), replacing bare "auditados y notificados". Combined with the Manual check ("aviso observable visible tras la ejecución sin confirmación"), §3.7 is now demonstrable at Slice 3 even though the full channel completes in Slice 5.

### F4 — DB-level idempotency in integration: APPLIED ✅

Slice 3 integration check now states: "Probar idempotencia contra la restricción única de la base de datos, no con un contador en memoria" (line ~206). Matches the repo pattern verified in pass 1 (`ON CONFLICT (idempotency_key) DO NOTHING` + unique constraint + atomic claim, `src/wallet/transfer-pipeline.ts:505-520` @ `99ad96b`).

### F5 — Provider Solana support as Slice 1 exit gate: APPLIED ✅

Slice 2 dependencies now include: "**Gate de salida de Slice 1**: confirmar que el proveedor seleccionado soporta Solana devnet y dejar registrado cualquier límite de fees o finalidad antes de empezar este slice" (lines 170-172). The REVALIDAR note remains and is now backed by a hard gate with a defined owner point (Slice 1 exit).

## Agreement coherence (second pass)

- **Solana-first decided**: §1 and §2.1 unchanged and consistent; §6.1 struck-through as resolved; §7 records no per-slice chain gate. ✅
- **Grant-covered execution without re-confirmation**: §1 + Slice 3 result observable ("sin pedir confirmación, con aviso visible"). ✅
- **Inline / unauthorized → preview + double confirmation**: §1 + Slice 3 E2E second turn ("fuera de autorización con preview y confirmación explícita") + Slices 4/7. ✅
- **Cross-doc consistency**: `03-design-discussion.md` §8 now lists "Red objetivo: Solana-first (decidida)" with wallet classes as the only pending product decision; `review-findings.md` records Solana-first as user-approved, strikes through the "outline not created / networks undecided" gate as "Superado (2026-10-03)", and names the independent review + outline-content approval as the remaining gate. Neither document any longer claims the network decision is pending. ✅

## Second-pass verdict

**PASS — no blockers.** All five first-pass dispositions (F1–F5) are correctly applied. One minor residual (F1-R: Slice 7 "testnet" wording, line 270) is recorded for the next outline touch; it does not affect Slices 1–4, which are the minimum demo path.

## Human approval

**PENDING.** Per the outline's own §7 and `review-findings.md`'s next-gate section, the following require explicit human approval before implementation:
1. Approval of the outline content itself (this second-pass PASS is the independent-review input, not the approval).
2. Wallet classes decision (§2.2 — embedded / read-only external / operable external).
3. Ratification of remaining open items listed in §2.3 (grant-granting channel, notification channel, multi-wallet scope).

No implementation work is authorized by this review. File 04 was not modified in either pass.
