# Intake

Outcome: Correct the blocking Slice 1 review defect before integrating PR #1.

Acceptance evidence: malformed claim amounts return a rejection without throwing, have runtime regression coverage, and cannot enter the claim ledger due to a database constraint; Hermes retests the new PR head and CI is green.

Authority granted: Ramiro's instruction to orchestrate PR review and integration for delegated-grant-core, including the corrections needed to clear review findings.

Read scope: PR #1 (`delegated-grant-core`), its approved OpenSpec proposal/spec/design/tasks, Pi's read-only review report, and relevant backend/frontend migrations and tests.

Write scope: this isolated PR worktree only; strict positive-integer validation in the claim service, its audit behavior and tests, plus a positive-amount constraint on the claim ledger in both migration mirrors. No unrelated refactors, live provider calls, wallet operations, or secret access.

Non-goals: changing ADR-1, implementing the Solana provider, enabling real Privy policy provisioning, or changing the rule that Hermes owns PR testing.

Consequence / uncertainty / reversibility / recurrence: bounded authorization correctness and user-visible status defects; low architectural uncertainty; changes are additive and revertible; finite one-time remediation.

Selected route: Oneshot, using the existing approved Slice 1 design and SDD artifacts; this is a localized review remediation, not a new product/design decision.

Active gate: User approval in the current conversation to complete PR #1 review/integration, narrowed by native review lineage `review-d9122237e9d5db5a` to critical finding `R4-claim-amount-not-validated-before-bigint`. Expired-grant display, unqualified Supabase identifiers, recipient validation, and provider-I/O locking are warnings or suggestions and are deferred; no real policy provider is enabled in Slice 1.

## Approval record

- Gate ID: user-request-pr1-review-integration-20261004
- Decision / allowed mutation: fix the single blocking amount-validation finding in a fresh worktree; push the PR branch after verification; wait for Hermes to retest; merge only when review and CI gates pass.
- Explicit exclusions: no other wallet behavior, live transactions, provider credentials, or main-worktree edits.
- Owning artifact / revision: PR #1 at `94e4ca347d26b17f34c31d674d3e5866283667da`; Slice 1 design `openspec/changes/delegated-grant-core/design.md` at that head.
- Decision owner: Ramiro.
- Approved by / trusted identity: User in this conversation.
- Approved at: 2026-10-04.
- Status: approved.
- Invalidated by: any change to the Slice 1 decision, action scope, authority, or owning design revision.
