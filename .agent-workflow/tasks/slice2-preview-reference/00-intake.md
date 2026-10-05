# Intake

Outcome: Close the pending Slice 2 retry review by requiring a persisted preview reference before Solana dispatch.
Acceptance evidence: Missing/blank `previewId` returns `not_dispatched` before blockhash RPC and signer dispatch; existing stable-reference ambiguous retry tests still pass.
Authority granted: Ramiro's instruction to finish the Slice 2 retry review, commit by phases, push to `origin`, and leave PR #2 ready.
Read scope: Solana provider, its unit tests, Slice 2 OpenSpec, PR #2.
Write scope: `src/wallet/solana-devnet-provider.ts`, `tests/unit/solana-devnet-provider.test.ts`, Slice 2 OpenSpec task/spec/verification artifacts, and this packet in the new Worktrunk worktree.
Non-goals: retry/resend behavior changes when an ID exists, unrelated provider changes, merge, live devnet transfer, Slices 6–7.
Consequence / uncertainty / reversibility / recurrence: bounded financial-safety bug; current code has an uncorrelatable synthetic fallback; reversible and testable locally.
Selected route: Oneshot — known files, one invariant, low rollback cost.
Active gate: `slice2-preview-reference-required`; approved by Ramiro's explicit Slice 2 retry-review instruction (2026-10-05).

## Approval record

Gate ID: `slice2-preview-reference-required`
Decision / allowed mutation: Add the failing regression, enforce fail-closed missing preview ID before RPC/signing, update Slice 2 SDD, verify, commit, and update PR #2 branch.
Explicit exclusions: No external wallet transfer or signing; no PR merge; no unrelated changes.
Owning artifact / revision: Slice 2 spec at base SHA `d5fe5ecc2fa48be23410ae73e91be794177df918` plus Ramiro's retry-review instruction.
Decision owner: Ramiro.
Approved by / trusted identity: Ramiro, current conversation.
Approved at: 2026-10-05.
Status: approved.
Invalidated by: Any scope change or change to the persisted-preview correlation requirement.

## Worktree receipt

- Repository: `/Users/ramiro/Desktop/projects/colloseum`
- Source branch: `slice2-provider-solana-devnet` at `d5fe5ecc2fa48be23410ae73e91be794177df918`
- Implementation branch: `fix/slice2-preview-reference`
- Worktree: `/Users/ramiro/Desktop/projects/colloseum.fix-slice2-preview-reference`
- Created with: `wt switch --create fix/slice2-preview-reference --base origin/slice2-provider-solana-devnet`
- Cleanup: retained until cherry-pick/push verification; then remove only this task-owned clean worktree.
