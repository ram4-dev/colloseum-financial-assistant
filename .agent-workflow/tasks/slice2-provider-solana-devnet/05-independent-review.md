# Independent Design Review — solana-devnet-provider (Slice 2)

## Review 1

- **Date:** 2026-10-04
- **Reviewer:** Independent Pi session, `nan/glm5.3-flash`, reasoning `high`
  (subagent id `subtask_jd-judge-a_1791121736058_5dc6c5f9`, fresh context,
  adversarial role, no author participation).
- **Scope reviewed (exact):** `openspec/changes/solana-devnet-provider/` —
  `design.md` (sha256 prefix `fd6a6265c47bc83d`), `specs/solana-devnet-provider/spec.md`,
  `proposal.md`, and `tasks.md` — plus grounding code: `src/wallet/provider.ts`,
  `src/wallet/circle-arc-provider.ts`, `src/wallet/grants/privy-policy-sync.ts`,
  `src/wallet/grants/engine.ts`, `src/server.ts:185-205`,
  `src/runtime/dependencies.ts:88-124`, `src/wallet/privy-transaction-transport.ts`,
  `src/wallet/privy-client.ts`, and plan Slice 2 + G4 research
  (`.agent-workflow/tasks/financial-assistant-development/01-propuesta-plan.md:148`,
  `06-research-d4-privy-solana.md`).
- **Note:** the review ran against design/spec/proposal as listed. `tasks.md`
  was compacted afterwards (542→525 words) purely for the sdd-tasks word
  limit; forecast lines, WU set, RED-first ordering, and every
  security/policy task from the reviewed revision were preserved
  (findings F3/F4 were already folded into tasks 1.4/1.5/2.5 before
  compaction). Disposition: no re-review required for tasks.md; a focused
  reviewer pass on tasks.md alone is deferred to Review 2 below only if the
  user requires byte-exact coverage — the semantic content is unchanged.
- **Verdict: FAIL** — 1 BLOCKER, 3 MAJOR, 2 MINOR, 1 SUGGESTION. No
  implementation may start until the BLOCKER and MAJORs are resolved in the
  artifacts and re-reviewed.

### Findings and dispositions

| ID | Sev | Area | Finding (summary) | Disposition |
| --- | --- | --- | --- | --- |
| F1 | BLOCKER | policy-path | No mechanism specified binding the provisioned Privy policy to the wallet's RPC signing path; `provider_policy_id` could be decorative while the enclave enforces nothing. | **Accepted.** Before GREEN: verify with dated primary source how Privy Solana policies bind (wallet-level `policy_ids` vs signer vs per-request), encode the attachment step explicitly in the `GrantPolicyProvisioner` contract, add a spec scenario asserting the enforcement binding, and resolve one-policy-per-signer vs one-policy-per-grant. Tracked in tasks 1.4/2.3; resolution evidence to be recorded before implementation. |
| F2 | MAJOR | rigor | Design promised Privy per-transfer/cumulative caps + temporal window, but G4 evidence says Privy has NO rolling cumulative cap and only static time windows. | **Accepted.** Restated provider plane honestly: enclave enforces per-transfer max, recipient allowlist, static expiry window mapped from `grant.expiresAt`; cumulative caps enforced solely by the ledger engine (hybrid division stated explicitly). Task 1.6 asserts no fabricated cumulative rule. |
| F3 | MAJOR | policy-path | Solana wallet RPC dispatch omits Privy authorization-signature handling; live calls would 401. | **Accepted.** Design/spec updated: dispatch carries the authorization signature via the existing `privy-transaction-transport.ts` signer seam; RED test asserts the auth-signature input on the dispatch shape (task 1.4). |
| F4 | MAJOR | seam | `walletReads` branch (`dependencies.ts:118-124`) not routed for `solana-devnet` — execution would use Solana but reads would silently stay on legacy WDK. | **Accepted.** Spec scenario + task 2.5/1.5 added: `walletReads` routes to `SolanaDevnetProvider` under `solana-devnet`; other branches byte-identical. |
| F5 | MINOR | honesty | Spec requirement text still used sign-then-self-submit (EVM) phrasing, contradicting the signAndSend model. | **Accepted.** Requirement rewritten to the single canonical model: Privy `signAndSendTransaction` signs AND broadcasts; provider never submits bytes to a Solana RPC endpoint; success scenario uses `hash` + `transaction_id`. |
| F6 | MINOR | spec | `receipt_invalid` scenario allowed two outcomes (untestable); no mechanism named for "past history window". | **Accepted.** Single deterministic behavior specified: `receipt_invalid` only when an address-based history read (`getSignaturesForAddress`) confirms the signature is outside the status window; otherwise poll to deadline and throw. |
| F7 | SUGGESTION | provisioning | ALT limitation (Privy does not resolve Address Lookup Tables) absent from design/spec. | **Accepted.** Design note + RED test added: transactions constructed without ALTs (explicit account list); policy rejection maps to `not_dispatched` with a distinguishable reason. |

### Gate

Per RPI rules: controlling findings (F1-F4) require artifact revision and
**another independent review** before the outline/design gate can be
approved. Review 2 outcome recorded below; implementation gated on it.

## Review 2

- **Date:** 2026-10-04
- **Reviewer:** Independent Pi session, `nan/glm5.3-flash`, reasoning
  `high` (subagent id `subtask_jd-judge-a_1791123948780_45afa23c`, fresh
  context, adversarial role; a prior R2 attempt on pre-audit hashes —
  `subtask_jd-judge-a_1791123145357_6bbe677f` — returned FAIL with R2F1
  MAJOR + 3 minors, all remediated before this final pass).
- **Scope reviewed (exact sha256-16):** design=`4eec77e3a3dd9702`,
  spec=`5b19ae30f0d83037`, tasks=`3b9236aac877019e`,
  proposal=`85795cce318548ac`, state=`c0e9f90027baac51`, all on git
  `607d3a351e37f90762ecc45292a9d9922ca3c576`. **Post-review residual folds
  (R2F5-R2F8) landed in a second pass** — final hashes after the folds:
  design=`3d00ef419a872ca5`, spec=`b3e95a17e930dd35`,
  tasks=`7e38f69a8d22f003`, proposal=`bb2810e06cca5eb3`,
  state=`5c36148e09ee4975`.
- **Verdict: PASS** — zero BLOCKER, zero MAJOR.
- **Resolution of Round-1 + first-R2 findings confirmed in artifacts:**
  R2F1 (revoke grant-context recompute, never-delete-while-siblings
  invariant, sibling-preservation RED test), R2F2 (canonical atomic
  signAndSendTransaction phrasing), R2F3 (wallet+walletReads routing
  scenario), R2F4 (receipt_invalid getSignaturesForAddress proof or
  deadline throw).

### Residual findings (non-blocking, all accepted)

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| R2F5 | MINOR | Uncertain shared-policy PATCH scope: ADR-2/spec say the triggering grant stays non-executable but don't state sibling grants' fate or audit attribution. | Accepted — fold into design ADR-2 step 3 + spec failure scenario (all active grants on the wallet degrade to `policy_not_ready` until verified re-sync; audit row names wallet/policy scope) and add RED test before GREEN. |
| R2F6 | SUGGESTION | Token-list drift: proposal mentions conditional devnet USDC; design says SOL-only; no listTokens scenario. | Accepted — pin SOL-only in proposal; listTokens covered by contract test 1.1. |
| R2F7 | SUGGESTION | Revoke-path serialization not explicit in concurrency scenario/task. | Accepted — extend task 1.6 + spec scenario to include revoke in the per-wallet lock test. |
| R2F8 | SUGGESTION | Attach complete-list mutation (preserve other signers) lacks RED test item. | Accepted — add to task 1.6 before GREEN. |

### Gate outcome

PASS recorded on the exact hashes above. Per RPI rules the independent
review gate is satisfied; the four residual non-blocking findings are
dispositioned as pre-GREEN artifact folds (R2F5-R2F8) that do not change
any controlling decision. Implementation (Strict TDD) may start.

## Review 3

- **Date:** 2026-10-04
- **Reviewer:** Independent Pi session, `nan/glm5.3-flash`, reasoning
  `high` (subagent id `subtask_jd-judge-a_1791125693857_18d674fe`, fresh
  context, adversarial role; verified premises against installed
  node_modules peer manifests and live npm registry).
- **Scope reviewed (exact sha256-16):** design=`ffd186e62c7debce`,
  spec=`b3e95a17e930dd35`, tasks=`bc6931a9c10e9fb0`,
  proposal=`663f623f4559bf86`, state=`b1159a013587800c`.
- **Trigger:** ADR-1 revised — `@solana/kit` 8.4.0 →
  `@solana/web3.js@1.98.4` (registry peer incompatibility: Circle 10.8.0
  peers Kit ^2.1||…||^6; Privy 0.34.0 peers ^5.1.0; Kit 5.5.1 requires
  TypeScript ^5.0.0 vs repo TS 6.0.3).
- **Verdict: PASS** — zero BLOCKER, zero MAJOR.

### Findings and dispositions

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| R3F1 | MINOR | ADR-1 overstated peer failures: Circle/Privy mark @solana/kit peers OPTIONAL (warnings, not hard fails); the hard fail is Kit 5.5.1's REQUIRED TypeScript ^5.0.0 peer vs repo TS 6.0.3. Decision unchanged. | Accepted — ADR-1 evidence wording corrected. |
| R3F2 | MINOR | state.yaml misattributed Review 2 PASS hashes (Review 2 PASSed pre-fold hashes; folds + ADR-1 revision covered by Review 3). | Accepted — state note reworded; Review 3 hashes recorded here. |
| R3F3 | SUGGESTION | No mechanical guard enforcing the no-local-keypair invariant after the web3.js swap. | Accepted — RED test/lint guard added (task 1.4, design). |
| R3F4 | SUGGESTION | Status-cache window: `getSignatureStatuses` needs `searchTransactionHistory: true` and a history-present resolution branch (via `getTransaction`); else slow finality polls to deadline despite finalized tx. | Accepted — finality flow specifies both; added to RED matrix. |
| R3F5 | SUGGESTION | Unsigned serialization unspecified: `Transaction.serialize()` throws unsigned; correct call `serialize({requireAllSignatures:false, verifySignatures:false})`. | Accepted — named in design, asserted in dispatch-shape RED test. |

### Gate outcome

PASS. R3F1-R3F5 folded into artifacts post-review; a focused Review 4 on
the corrected hashes gates RED.

## Review 4

- **Date:** 2026-10-04
- **Reviewer:** Independent Pi session, `nan/glm5.3-flash`, reasoning
  `high` (subagent id `subtask_jd-judge-a_1791126470149_79a27e69`, fresh
  context, focused adversarial verification of R3 folds).
- **Scope reviewed (exact sha256-16, post-R3F final):**
  design=`f90a427fb00a8c75`, spec=`b3e95a17e930dd35`,
  tasks=`62f4001cb2b40069`, proposal=`663f623f4559bf86`,
  state=`e696ec8f09f084fd`, on git `607d3a351e37f90762ecc45292a9d9922ca3c576`.
- **Verdict: PASS** — all five R3 folds verified present (R3F1 evidence
  precision, R3F2 state honesty, R3F3 no-keypair guard, R3F4
  searchTransactionHistory/getTransaction branch, R3F5 unsigned
  serialization options); word limits met (design 797/800, tasks 529/530);
  decisions unchanged; no new contradictions.
- **Residual:** R4F1 SUGGESTION — pointer accuracy (this section now
  records the hashes, closing the nit).

### Gate outcome

PASS on final hashes. Review gate closed; Strict TDD (RED first) authorized.

## Review 5

- **Date:** 2026-10-04
- **Reviewer:** Independent Pi session (el Gentleman harness), fresh context,
  adversarial role, reasoning high; no author participation. Did not trust
  earlier PASS verdicts; re-derived everything from current artifacts and code.
- **Instruction scope:** verify ADR-3 per-user binding against actual schema,
  embedded-wallet resolution, `PrivyServerClient` chain listing, and the
  financial route/worker `walletForUser` call chain; hunt tenant-isolation
  bypass, ambiguous wallet selection, schema/type/API mismatches, tasks/spec
  test coverage; review other SDD decisions for contradictions.
- **Scope reviewed (full sha256, verified before analysis):**

  | Artifact | sha256 |
  | --- | --- |
  | `proposal.md` | `82077759aaaeba5de3df817d9f7d535d44177b4a1d70551d327632fca7493f78` |
  | `design.md` | `1296c3298d6927dba769ded4d7dd31310e224ea7bd18ae30169efce2f3fd88bd` |
  | `specs/solana-devnet-provider/spec.md` | `99a26e6b539c774c3fae1223fee5a155ecfb104e9b9fc297eaab158bc16cf67b` |
  | `tasks.md` | `070d0b6ef3dced7cfdd516c6f986150b11020f6ade79fa9960ffa6d07dd307e5` |
  | `state.yaml` | `3050ff535072ec83b3c675e729515d9d1b552b93d2d822e038f539c0f0f86818` |

  All five match the gate hashes recorded in `state.yaml` notes (16-char
  prefixes agree), so the reviewed bytes are exactly the Review-5-gated
  revision.

- **Grounding evidence inspected:**
  `src/db/migrations/006_embedded_wallets.sql` (full: `user_wallets` CHECK
  states, `provider_wallet_id TEXT NOT NULL UNIQUE`, UUID PK with
  `gen_random_uuid()` default, partial unique index
  `user_wallets_one_active_per_user_chain_idx ... WHERE state='ready'`, RLS
  `app.user_id` policies);
  `src/wallet/solana-user-wallet.ts` (full `createSolanaWalletForUser`);
  `src/runtime/dependencies.ts:40-120` (`createConfiguredWalletForUser` — no
  Solana branch yet; `createWalletProvider` circle-arc branch);
  `src/wallet/privy-user-provider.ts` (`WalletForUser` type,
  `bindWalletForUser`, `readUserWalletSelection` referenced);
  `src/wallet/privy-server-client.ts:236` (`getVerifiedWalletForUser`);
  call-chain grep: `src/api/wallet.ts:198-216`,
  `src/conversations/service.ts:163,187-189,376,648,800,885`,
  `src/livekit/worker.ts:88-89`, `src/server.ts:171,184,214`.

### Verified positives

1. **Hashes/state consistency** — state.yaml gate hashes match the on-disk
   artifacts byte-for-byte; no post-gate drift.
2. **Tenant isolation in the resolver read path** —
   `solana-user-wallet.ts` reads `user_wallets` inside
   `database.withUserTransaction(userId, ...)` with an explicit
   `user_id = $1` predicate; migration 006 FORCEs RLS with
   `app.user_id`-scoped policies on all three tables. No cross-tenant read
   path found in the resolver.
3. **No global sender in financial call chain** — every observed consumer
   resolves per user: `api/wallet.ts:210-213` calls
   `dependencies.walletForUser(userId)`;
   `conversations/service.ts:187-189` binds via `bindWalletForUser` per
   `userId` and uses it at :376 (preview in-conversation), :648 (preview),
   :800 (broadcast), :885 (finality); `livekit/worker.ts:88-89` binds by
   `binding.userId`. No process-global Solana sender address is wired —
   consistent with state.yaml "global wiring paused until Review 5 PASS" and
   with `dependencies.ts:74-92` (EVM-only resolver, unchanged).
4. **Schema supports the readiness gate** — the partial unique index allows
   at most one `state='ready'` row per `(user_id, chain_family)`; the
   resolver's fail-closed throw on 0 rows and on non-ready state aligns with
   ADR-3 step 1's missing/not-ready arms.
5. **Design/spec coherence on ADR-3 intent** — design ADR-3, spec
   "Per-user Solana wallet binding" requirement, proposal Scope bullet 3,
   and task 2.6 all describe the same resolver seam and additive
   `listWalletsForChain` generalization; no contradiction between artifacts
   on intent.

### Findings and dispositions

| ID | Sev | Area | Finding (evidence) | Disposition |
| --- | --- | --- | --- | --- |
| R5F1 | MAJOR | ADR-3 duplicate-binding semantics | Design ADR-3 step 1 says "exactly one **ready** binding (missing/multiple/not-ready → fail closed)"; the implementation queries ALL rows for the user with `chain_family='solana'` unfiltered by state (`solana-user-wallet.ts`, first query) and throws `wallet_config_error` when `readiness.length > 1` — i.e. one ready row plus ANY stale non-ready row (`provisioning`/`conflict`/`unavailable`) bricks the user's Solana resolution, though the schema index guarantees only one can be ready. Spec scenario "more than one binding" and task 1.7 "duplicate ... bindings" inherit the same ambiguity: it is not decidable from the artifacts whether the RED test must encode "duplicates among ready rows" (DB-impossible) or "duplicates among all rows" (user-bricking). | **Blocking.** Pick one semantic and align design+spec+tasks+test before GREEN: recommended — gate on ready rows (`WHERE state='ready'`, 0→`wallet_not_ready`), and treat multi-row any-state as a separate, explicitly chosen policy (current impl's stricter behavior is acceptable only if spec says so). |
| R5F2 | MAJOR | ADR-3 identity match | The Privy-vs-local match is wrong and incomplete: `if (wallet.id !== binding.id)` compares the Privy wallet id against the local row's UUID **primary key** (`user_wallets.id UUID DEFAULT gen_random_uuid()`), while the schema's dedicated field for the Privy id is `provider_wallet_id TEXT NOT NULL UNIQUE` — selected by the query but never used. As written, a correctly provisioned user can never match (Privy ids are not the local UUID), so the spec acceptance scenario "User with one ready Solana wallet gets a bound provider" is unsatisfiable. Additionally the code never compares `wallet.address` to `binding.address`, although design ADR-3 step 2 and the spec scenario require matching on "(id **and address**)". Fail-closed (throws, no provider, no fund risk), so this is a functional blocker, not a safety breach. | **Blocking.** Compare `wallet.id !== binding.provider_wallet_id` and add the address equality check; assert both in the task-1.7 RED test. Note: the mismatch test as currently conceivable (comparing PK) would pass for the wrong reason. |
| R5F3 | MINOR | error taxonomy | On Privy discovery failure the resolver throws `wallet_unavailable` (`solana-user-wallet.ts`, catch around `listWalletsForChain`); design ADR-3 and the spec failure scenario enumerate only `wallet_not_ready` / `wallet_config_error`. The spec's fail-closed scenario does not cover the Privy-outage arm, so a RED test for it has no spec anchor. | Fold `wallet_unavailable` (Privy discovery outage) into the spec scenario and task 1.7 before GREEN. |
| R5F4 | MINOR | process/apply-gate | `state.yaml` says apply `in_progress` and "global wiring paused; no global wiring until Review 5 PASS", yet `src/wallet/solana-devnet-provider.ts` and `src/wallet/solana-user-wallet.ts` already exist (WU2 files). Verified no wiring landed (`dependencies.ts`/`server.ts` show no solana branch), so the pause holds — but the resolver containing R5F1/R5F2 was written pre-gate, which is exactly the risk the pause is meant to contain. | Keep the pause. Fix R5F1/R5F2 in place before any `createConfiguredWalletForUser` solana branch; no artifact change required beyond the note. |
| R5F5 | MINOR | seam existence | `grep listWalletsForChain src/wallet/privy-server-client.ts` returns nothing — the method the resolver calls does not exist yet on `PrivyServerClient` (which today exposes `getVerifiedWalletForUser` at :236). Proposal/tasks correctly scope it as additive work (task 2.6), and the EVM path is verified untouched — so this is an open GREEN item, not a design defect. But Review 5 was asked to verify the "PrivyServerClient chain listing": it cannot be verified against code because it is unimplemented; its request/response semantics (chain_type filter, archived handling, pagination) are therefore **unverified against any primary source in the artifacts**. | Before GREEN: implement `listWalletsForChain` and record its Privy API evidence (dated) in the design or a research note; add RED coverage via the injected `PrivyServerClient` double. |
| R5F6 | SUGGESTION | test coverage / hygiene | (a) Task 1.7 says "Privy mismatch fail closed" generically — it never names the address-equality assertion the spec requires (id AND address). (b) `async () => binding.address ?? ""` in the rpc sender callback is dead code — `user_wallets.address` is `NOT NULL` (migration 006); the `?? ""` invites a silently empty sender if the invariant ever regresses. | (a) extend task 1.7 wording; (b) drop the `?? ""` or assert non-empty. Non-blocking. |

### Tenant-isolation / bypass verdict on ADR-3

No tenant-isolation bypass found: the only Solana wallet resolution path is
per-user, RLS-scoped, fail-closed on 0/ambiguous matches, and constructs the
provider solely from the user's own binding. The defects found (R5F1/R5F2)
all fail **closed** — they deny service, never widen it. Ambiguous wallet
selection exists only in the duplicate-rows semantics (R5F1), and the
implementation's current answer (refuse) is the safe side of the ambiguity.

### Other SDD decisions — contradiction scan

ADR-1/ADR-2 carry no new internal contradictions against the code inspected:
no `Keypair.*` usage observed in `solana-user-wallet.ts` (construction goes
through `SolanaDevnetProvider` + `privySignAndSendFromEnvironment`);
per-wallet lock, composed-policy, and fail-closed language is consistent
between design and spec. Acceptance-gap check on tasks: tasks 1.x/2.x cover
the spec scenarios with one gap each noted in R5F3 (unavailable arm) and
R5F6a (address assertion). `MODIFIED/REMOVED: None` in the spec delta is
consistent with the strictly-additive wiring claim, which code inspection
supports so far (no existing branch touched).

### Limitations (recorded, not explored further per instruction)

- `readUserWalletSelection` internals (`privy-user-provider.ts:212`) were not
  read line-by-line; its contract is taken from usage.
- End-to-end execution of the financial route/worker chain was verified by
  call-site inspection only, not by running tests (apply is in_progress; RED
  tests not yet asserted to exist).
- `listWalletsForChain` Privy API semantics unverified (R5F5 — method absent
  from the client).
- Privy policy/signer primary sources (ADR-2) were not re-fetched this
  review; ADR-2 was audited for internal consistency only, not re-evidenced.
- E2E/devnet smoke and explorer behavior: out of reach (env-gated, Slice 3).

### Verdict

**FAIL** — zero BLOCKER, **2 MAJOR** (R5F1, R5F2), 3 MINOR, 1 SUGGESTION.
Both MAJORs are fail-closed functional defects in the ADR-3 resolver, not
safety breaches, but R5F2 makes the spec's central acceptance scenario
unsatisfiable as coded, and R5F1 leaves the duplicate-binding contract
undecidable across design/spec/tasks/tests. **Gate:** keep the global-wiring
pause; remediate R5F1 + R5F2 (artifact alignment for R5F1, code + RED-test
fix for R5F2), fold R5F3/R5F6 pre-GREEN, implement and evidence
`listWalletsForChain` (R5F5), then run a focused re-review of the remediated
resolver + updated artifacts before any wiring lands.

## Review 6

- **Date:** 2026-10-04
- **Reviewer:** Independent Pi session (el Gentleman harness), fresh context,
  adversarial role, reasoning high; no author participation. Did not trust the
  author or prior verdicts; re-derived everything from current bytes, code,
  and primary sources.
- **Instruction scope:** verify exact remediation of Review 5 findings only,
  scan for new contradictions. No implementation, SDD, or state edits made.
- **Full sha256 computed BEFORE analysis** (`shasum -a 256`):

  | Artifact | sha256 |
  | --- | --- |
  | `proposal.md` | `d56aabc2f81ee027c9977e4160c3f717bb8e2b12fcb45adaf8c81050e638019b` |
  | `design.md` | `d4c54bf39e171236f47003c82457c82bbef5d776653e8e075c150c3273489a8a` |
  | `specs/solana-devnet-provider/spec.md` | `f705d1f053ec30c25f27348f5ac81044396633320283524781c15df720278d5e` |
  | `tasks.md` | `141a5cc36dc450090b65507c89ca87565f04929496ca13a02259960d97812edb` |
  | `state.yaml` | `50347b1d4890614753b1450b7efe83fbc6cf6309afef15b5ad1551af76d79552` |

  All four artifact hashes match the `Review 6 PENDING` gate entries in
  `state.yaml` byte-for-byte. (Note: the task shorthand listed `d4c54...`
  next to "proposal"; that prefix is `design.md`'s. The authoritative
  state.yaml binding is exact and matches on all four.) The reviewed bytes
  are exactly the post-R5-remediation revision.

### Remediation verification (R5 findings)

| ID | Required remediation | Verified evidence |
| --- | --- | --- |
| R5F1 (MAJOR) | Pick one duplicate-binding semantic; ready-only gate recommended. | **Verified.** Design ADR-3 step 1 now reads "ready rows only — `user_wallets WHERE user_id AND chain_family='solana' AND state='ready'`; exactly one required (0 → `wallet_not_ready`; >1 → `wallet_config_error`)... Stale non-ready rows do not invalidate it." Spec scenario "User with one ready Solana wallet gets a bound provider" now includes "plus any number of stale non-ready rows" and "the stale non-ready rows do not invalidate the binding"; the failure scenario is scoped to "zero ready... more than one ready binding". Task 1.7: "ready-only gate (stale non-ready rows tolerated)". Design/spec/tasks/test contract now decide the same semantic (the recommended one), eliminating the R5F1 undecidability. |
| R5F2 (MAJOR) | Match on `provider_wallet_id` AND `address`, never the local UUID PK. | **Verified.** Design ADR-3 step 2: "matching the binding on BOTH `wallet.id === binding.provider_wallet_id` AND `wallet.address === binding.address` (never the UUID PK)". Spec failure scenario: mismatch = "does not equal the local binding's `provider_wallet_id` OR its `address`"; success scenario requires both "compared independently". Task 1.7: "asserting BOTH `provider_wallet_id` and `address` separately (never local UUID PK)". |
| R5F3 (MINOR) | Fold `wallet_unavailable` (Privy discovery outage) into spec + tasks. | **Verified.** Design ADR-3 step 2: "listing failure → `wallet_unavailable`". Spec has a dedicated scenario "Privy discovery outage fails closed as wallet_unavailable" (listing network/5xx failure → `wallet_unavailable`, no provider, local binding unchanged). Task 1.7: "`wallet_unavailable` arm". Spec anchor for the RED test now exists. |
| R5F5 (MINOR) | Evidence `listWalletsForChain` request/response semantics from primary sources; scope runtime solana-page check as implementation verification. | **Verified against both primary sources, independently re-derived:** (1) installed `node_modules/@privy-io/node@0.34.0` — `resources/wallets/wallets.d.ts:3712` `WalletListParams extends CursorParams` with `user_id?: string` ("Cannot be used together with authorization_key"), `chain_type?: WalletChainType` where `WalletChainType` (line 3407) includes `'solana'`, `include_archived?: boolean` "Defaults to false", and `CursorParams` (`core/pagination.d.ts:43`) = `{ cursor?, limit? }`; (2) docs.privy.io/api-reference/wallets/get-all (fetched 2026-10-04) confirms identical semantics (`user_id`, `chain_type` incl. `solana`, `cursor`, `limit ≤ 100`, `include_archived` default false; response = `data[]` + `next_cursor`). Design ADR-3 step 2 states exactly this. The runtime solana single-page check is correctly scoped as the implementation verification item in task 2.6 ("runtime-verify solana single-page response"), not claimed as done. |
| R5F6 (SUGGESTION) | Task 1.7 must name the address assertion; drop nullish sender fallback. | **Verified.** Task 1.7 now contains "no nullish sender fallback" as an explicit RED item; design ADR-3 step 3: "sender = `binding.address` (`NOT NULL`, no nullish fallback)". Both parts folded. |
| R5F4 (MINOR) | Keep the global-wiring pause. | **Verified.** state.yaml: "Global-sender wiring stays paused; no wiring until Review 6 PASS." Git status confirms no wiring landed: `src/runtime/dependencies.ts` has no solana branch for `createConfiguredWalletForUser`; only additive WU2 files exist (`solana-devnet-provider.ts`, `solana-user-wallet.ts`). |

### Pending-code note (not a finding)

The resolver code (`src/wallet/solana-user-wallet.ts`) still contains the
pre-remediation behavior R5 flagged (unfiltered SELECT counting all rows,
`wallet.id !== binding.id` PK comparison, `?? ""` sender fallback), and
`privy-server-client.ts` has no `listWalletsForChain` yet. This is the
expected pre-GREEN state: tasks 1.7 (RED tests) and 2.6 (implementation) are
unchecked, and apply is `in_progress` with the wiring pause in force. The
artifacts now unambiguously specify the target semantics; the code must be
brought to them RED-first before any wiring. Consistent with the R5
dispositions; no contradiction.

### New-contradiction scan

- design ADR-3 (ready-only gate, dual match, `wallet_unavailable`, no
  nullish fallback, `listWalletsForChain` evidence) ↔ spec scenarios
  (success incl. stale rows; failure arms; outage arm) ↔ task 1.7/2.6 ↔
  proposal Scope bullet 3 ("ready-only gate... stale non-ready rows
  tolerated... id-or-address mismatch"): all four artifacts state the same
  semantics; no drift.
- Schema grounding re-checked: migration 006's partial unique index
  (`WHERE state='ready'`) makes >1 ready an integrity anomaly, matching the
  design's defensive `wallet_config_error` arm; `address`/`provider_wallet_id`
  are NOT NULL/UNIQUE as the dual match assumes.
- `MODIFIED/REMOVED: None` remains consistent with the additive claim
  (no existing selection branch touched in the working tree).
- ADR-1/ADR-2 and the threat-model text show no new internal contradictions.

### Word budgets

design.md = **797/800** ✓; tasks.md = **530/530** ✓ (at limit, within
budget). proposal.md = 546, spec = 1887 (not budgeted).

### Verdict

**PASS** — zero BLOCKER, zero MAJOR. All six R5 review findings (R5F1–R5F6) are
remediated in the gated artifacts exactly as dispositioned; no new
contradictions; budgets met; hashes bound.

### Gate outcome

PASS on the post-R5 hashes above. Conditions carried forward (no change in
scope): (1) task 1.7 RED tests must encode ready-only gating with stale-row
tolerance, the `provider_wallet_id` AND `address` assertions (failing against
the current PK-comparison code for the right reason), the
`wallet_unavailable` arm, and no nullish sender fallback; (2) resolver code
fix + `listWalletsForChain` (task 2.6) land only through those RED tests;
(3) the global-wiring pause lifts only after the RED tests and resolver fix
are in place — per state.yaml, "no wiring until Review 6 PASS" plus the
carried conditions above. Stop: idle.

## Review 7 — ADR-4/5 signer-binding amendment (FAIL)

- Independent Pi reviewer: `pi-slice2-sdd-amend-review`, GLM 5.3 Flash high,
  Herdr session
  `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.slice2-provider-solana-devnet--/2026-10-04T18-47-49-569Z_01a1083e-6641-7ba8-a15d-1e3279759916.jsonl`.
- Verdict: **FAIL — 2 MAJOR, 0 BLOCKER**. Recomputed exact hashes:
  proposal `d56aabc2f81ee027c9977e4160c3f717bb8e2b12fcb45adaf8c81050e638019b`,
  design `5987d0f2df4ad621bb142ed854f0b99557b2da054c4f424ca9f9b8c369e8142c`,
  spec `ab848289c89db6d1b242cd6a393c68025915b10ecddbc5630d83f0c6a2e7b0dd`,
  tasks `587f7b6c4c5df7e3e4547ca4701034bf8ffda794430e00b4fe3374f01ca6a0e0`,
  state `9a833121eaaaae6d540faedbe863d719dd651380894efa1d2e2c2575731f3a05`.
- M1: proposal.md:74-78 contradicted the required additive signer-column migration
  by promising "no migrations" and omitted signer binding / chain intent from
  In Scope. Remediation: proposal scope and rollback updated.
- M2: tasks.md:10,67 targeted stale `delegated-grant-core`; `origin/main` is
  squash merge `c4d56c3`, and `607d3a3` is not its ancestor. Remediation:
  tasks now require rebase onto and PR target `main`.
- Residual minors: design/tasks budgets near limit; verify RED ordering before
  GREEN; schema and provider-seam grounding passed; chain routing remains
  implementation work. The reviewer found no other MAJOR or BLOCKER.
- The PASS conditions were limited to the two documentation fixes above.

## Review 8 — remediation re-review (PASS)

- Independent Pi reviewer: same read-only session, GLM 5.3 Flash high.
- Verdict: **PASS — zero BLOCKER, zero MAJOR**, bound to recomputed hashes:
  proposal `a2dcc13eca241345bfaa190fac289d4413db6a784c3b922cf67ff8468b7c39d9`,
  design `5987d0f2df4ad621bb142ed854f0b99557b2da054c4f424ca9f9b8c369e8142c`,
  spec `ab848289c89db6d1b242cd6a393c68025915b10ecddbc5630d83f0c6a2e7b0dd`,
  tasks `16406ad2defac4229045a5d290b1b848a5edb00e7d194c37cc7fed0553d324ea`,
  state `68c00672e0a273ce9ec56ce8281fdb9329aef17cfd4f76fb16d5571fb5e7a13d`.
- M1 and M2 are resolved. Cross-artifact signer, chain-intent, migration,
  backfill, and RED-before-GREEN contracts align. Budgets: design 796/800,
  tasks 529/530. Full terminal output is preserved in the Herdr session above.
- Residual suggestions: design/tasks budget headroom is nearly exhausted;
  proposal wording can align signature lookup with reference-id reconciliation;
  verify the RED tests before implementing 2.7/2.8. No implementation work was
  part of this review.

## Review 9 — Solana enrollment and policy DSL amendment (PASS)

- Independent Pi reviewer: `pi-slice2-sdd-amend-review`, GLM 5.3 Flash high,
  Herdr session `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.slice2-provider-solana-devnet--/2026-10-04T18-47-49-569Z_01a1083e-6641-7ba8-a15d-1e3279759916.jsonl`.
- Verdict: **PASS — zero BLOCKER, zero MAJOR** on proposal
  `b0552f32f55ffd437e28055053a7629ab90bf182fa7929630b3ee9c8ca81d99d`, design
  `958f02c9022810dedd7dd10b907e47ad9c1fa93770259829338b4a692f66d5e5`, spec
  `52c3dfdd7ffbc45d7cbf12437763b8cc78ca56261b9fc87c6c00bc30c89afeb0`, tasks
  `8bbc29c2fac49cae892faca005ee95b0f3c7101cb9cad3f8fb094850ef3aa763`, and
  state `693dc33ebbc24a20ef8bfc97ded441ae1160b4f2a33bd0dd8fb59b1a66580278`.
- Review verified durable `signer_enrollment_snapshot` design; precise signer
  discovery/readback; proposal scope; documented Solana condition sources and
  fields; all-instruction ALLOW and ALT limits; and the completed D-4 research
  gate. The current code uses wrong policy fields, and task 1.11 now requires
  a RED contract test before fixing it.
- MINOR: test must pin strict expiry `lt` (not current code's `lte`). MINOR:
  state delivery strategy was stale. SUGGESTION: clarify reference id vs
  signature wording. All three addressed in a metadata/document cleanup.
- Initial Review 9 hashes above were superseded by the final hash refresh below;
  all residual findings were resolved before implementation resumes.

### Review 9 final hash refresh — PASS

- The reviewer rechecked the final changes: task 1.11 pins expiry `lt`,
  `delivery_strategy` is `exception-ok` for the requested single PR per slice,
  and proposal wording names the stable Privy reference id plus on-chain
  signature lookup.
- **PASS — zero BLOCKER, MAJOR, MINOR, or SUGGESTION** on exact current hashes:
  proposal `a3238a4bda678d093355dc01b5c29316a6d7df22ec60068288b40e0bf1bbf8cf`,
  design `958f02c9022810dedd7dd10b907e47ad9c1fa93770259829338b4a692f66d5e5`,
  spec `52c3dfdd7ffbc45d7cbf12437763b8cc78ca56261b9fc87c6c00bc30c89afeb0`,
  tasks `d395726d9819c85f7fe3f424a3cb7eba5ff244890dba89d68b8bef614e9324a2`,
  state `1c91330cc3ae0d9811bbff65f16de3515b02a8b429d1d97f4114c825e601882f`.
- Design remains 794/800 words; tasks 497/530. This closes the design gate;
  task 1.11 is still RED work and must precede code changes to the policy DSL.

## Review 10 — migration claim correction (PASS)

- Independent Pi reviewer: `slice2-migration-claim-review`, GLM 5.3 Flash high,
  Herdr session `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.slice2-provider-solana-devnet--/2026-10-04T21-20-22-641Z_01a108ca-1071-7175-9f1e-ff605cfefa3a.jsonl`.
- Verdict: **PASS, no findings** on exact hashes: proposal
  `d4feacbb9c435cdfaad1a069f04c4ae01b6c768457eb8dd0078e9536a856e703`, design
  `7d60ccde5ff41db2993aa29be70e58c292e2958a3f495a8b70e660db7fcb04c9`, spec
  `52c3dfdd7ffbc45d7cbf12437763b8cc78ca56261b9fc87c6c00bc30c89afeb0`, tasks
  `4086f46b05272556a91810acb275ea08dd5a0e4184da0a71c3796d861a66f596`, state
  `ea46291389799a209abc51cf65cdda68bae3f9d0ba85075bea24fc9d34c42986`.
- Reviewer independently confirmed `origin/main` migration 006 has
  `provider_signer_id` only on `signer_grants`, not `user_wallets`; migration
  010 is the next sequence number and now owns both canonical wallet signer
  id and durable enrollment snapshot. Proposal, design, tasks and state agree;
  backfill matches `07-signer-binding-decision.md`; no remaining artifact says
  the wallet signer column exists in migration 006. Review 9 is superseded only
  for that corrected schema claim.
- State-only refresh: reviewer rechecked the updated bookkeeping with the same
  proposal/design/spec/tasks hashes above and state
  `0c6a5cb6bb1e8a466a76c4e97d1224b8cee4e29b74a1d2966c2896824968ac6d`;
  **PASS**. The update records Review 10 PASS and authorizes GREEN without
  changing any design decision.

## Review 11 — Task 2.3 chain-domain audit (FAIL; remediated)

- Independent Pi reviewer, GLM 5.3 Flash high, Herdr session
  `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.slice2-provider-solana-devnet--/2026-10-04T23-05-51-809Z_01a1092a-a3c1-7aac-8bca-4a86465e7e06.jsonl`.
- Confirmed blocker: `delegated_grants.chain` defaults to `solana`, while the
  initial adapter gated and queried `solana-devnet`. Actual sync rejected valid
  grants; the reverse value could omit sibling grants in policy recompute.
  No other blocker was found. Corrective direction: preserve ledger family and
  isolate the provider's devnet network value.

## Review 12 — amended chain-domain SDD (PASS)

- Same reviewer/session as Review 11. Exact hashes recomputed and matched:
  proposal `d4feacbb9c435cdfaad1a069f04c4ae01b6c768457eb8dd0078e9536a856e703`,
  design `2beaf94c278f0a97d2f76984acfc757ff3f1e0e8ff5ee4f55450ade269a88c97`,
  spec `8420fdea8aa782df7b798d2321e3c9b442d9d17cdd4cc81dad1e572c01affd8f`,
  tasks `4ed344db5244b0c7dd11083917e45508c309f68555c0812068cb879bc700cb74`.
- PASS: ledger family stays `solana`; provider network stays `solana-devnet`;
  Privy policy retains its devnet-scoped CAIP-2 resource; tasks 2.3 and 2.8
  distinguish those domains; no migration, API, or Slice 6/7 scope change.

## Review 13 — task 2.3 chain-domain remediation (PASS)

- Same independent reviewer/session. Current code hashes reviewed:
  `privy-policy-runtime.ts`
  `6f9391e5996a250cc2418f86e01bf855348fffc8695387fff5749b346c47fcad`,
  `grants-policy-runtime.test.ts`
  `540fd49cffdd4d82ad749e08f5f529e4423cbc299c5f0452d5a882b94f33f281`.
- PASS: stored `solana` family is passed through scoped grant queries and all
  runtime gates; non-Solana input fails closed; policy resource remains pinned
  to devnet. No remaining task-2.3 mismatch.
- Verification: 63/63 focused unit tests; 7/7 Postgres integration tests;
  typecheck, lint, and diff-check pass.

## Review 14 — task 2.5 provider selector and reads wiring (PASS)

- Same independent Pi reviewer/session. Files reviewed:
  `dependencies.ts`
  `cdec2cf5063b4a73e9e73574849f4eac8e616ab99f136a26d4682bf273ea80c4`,
  `solana-devnet-wiring.test.ts`
  `95ece974dd20053b5d85db737ef808ec074a8dbfabb8beb15b30aa3be47467d2`.
- PASS, no concrete findings: selector is additive; explicit incompatible
  network/token values fail before provider construction; unset remains
  allowed; `walletReads` shares the devnet provider; circle-arc/live/unset
  behavior remains unchanged.
- Verification: 58/58 focused tests; typecheck, lint, and diff-check pass.

## Review 15 — task 2.7 migration snapshot column (PASS)

- Independent Pi reviewer inspected both migration files. Exact reviewed hashes:
  local migration `5e175cd60d52ab8713653642adead945ad820be171217fc0c600ce4202c006a4`,
  Supabase mirror `26653fedfb3281990bc2828fc66d7937dbf702aa311e5d4074fdbecdd14a9669`.
- PASS: both add nullable JSONB `signer_enrollment_snapshot` idempotently;
  canonical `provider_signer_id` backfill and `IS NULL` guard are preserved;
  schema prefixes/search path are correct; no destructive change. Minor
  comment parity notes do not affect behavior.
- Verification: migration-column integration 1/1 and signer-backfill suite
  4/4 pass; typecheck, lint, and diff-check pass.

## Review 16 — task 2.7 canonical signer race guard (PASS)

- Independent Pi review in `w5:p46` / `w5:t2A`, session
  `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.slice2-provider-solana-devnet--/2026-10-05T00-11-58-567Z_01a10967-2ae7-791d-9059-cc7e8c4abff4.jsonl`.
- PASS: guarded `UPDATE ... RETURNING` detects a concurrent binding; the same
  transaction permits only an exact same-id readback and otherwise leaves the
  grant pending. The integration test deterministically writes a competing id
  between wallet read and guarded update, and asserts both binding and grant.
- Strict TDD evidence: regression RED (`verified` was true); GREEN after fix.
  Enrollment integration 33/33; typecheck, lint, build, and diff-check pass.
- Non-blocking review note: repeat `completePermission` after successful commit
  should return the same verified result. Added a regression; its RED was
  `GrantNotFoundError`, then GREEN after making the active Solana grant
  idempotently readable. Fresh independent Pi re-review returned PASS with no
  correctness, security, or regression findings on the guard and retry path.
  Session: `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.slice2-provider-solana-devnet--/2026-10-05T01-34-30-637Z_01a109b2-baed-7f35-a1a9-2ea2d4b810a2.jsonl`.
- Open BLOCKER from the same review: the current `per_transfer_atomic6` / USD
  10 intent is passed to a Solana `Transfer.lamports` cap without an approved
  denomination conversion. Do not mark task 2.7 complete until clarified and
  represented in the SDD and grant summary.

## Review 16 denomination follow-up — resolved by user decision

- Ramiro approved the fixed native-SOL cap of 0.01 SOL (10,000,000 lamports)
  with no oracle. This closes the review's missing-denomination decision gate.
- The Solana provider policy now uses the exact lamport cap; migration 011
  persists `signer_grants.per_transfer_lamports`; enrollment returns
  `perTransferSol: '0.01'` and an empty USDC amount. Delegated grants reject
  amounts above 10,000,000 at both HTTP schema and service boundaries and
  render lamports as SOL. EVM keeps its `per_transfer_atomic6` path.
- RED/GREEN: delegated-grant HTTP test failed on 10,000,001 before the guard
  and now returns 400 while 10,000,000 returns 200; enrollment query RED on the
  absent migration column, then GREEN with the persisted 10,000,000 and API
  summary assertions. Frontend covers over-cap rejection and exact conversion
  of 9 fractional SOL digits to lamports.
- This follow-up records implementation evidence after the explicit decision;
  it is not an additional independent Pi review. The separate race/retry
  verdict from Review 16 remains PASS.
