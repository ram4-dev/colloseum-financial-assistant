# Independent outline review — Slice 5

Status: review 1 complete; findings resolved on the primary branch; final independent check pending.

## Review 1 — Pi / GLM 5.3, 2026-10-05

- Reviewed branch `slice5-notifications` at `f4d0aa1` from an isolated Worktrunk checkout; read-only. The reviewer examined all Slice 5 RPI/OpenSpec artifacts and verified source behavior.
- Reviewer session: Herdr workspace `w5`, tab `w5:t2R`, pane `w5:p4Q`, agent `slice5-outline-review-glm53`; model `nan/glm5.3-flash`, reasoning `high`. Session reference is recorded in `herdr-session.md` in the review worktree.
- Findings: F1 HIGH: notify `uncertain`; F2 MEDIUM: post-commit hook can lose notices; F3 MEDIUM: table-specific system/user RLS; F4 LOW: duplicate-insert loser semantics; F5 LOW: specify polling and signature windows; F6 INFO: forecast undercounts tests. `not_dispatched` returns to `previewed`, is retryable, and should remain notification-free.
- Pi recommended accepting F2's residual risk for this slice; the implementation plan instead selects a transactional outbox because the approved intake requires every assistant execution to leave a durable notice. RLS uses explicit system-context-only policies, retaining FORCE RLS and preventing feed access from service transactions.
- All findings are addressed in current SDD: `uncertain` is notified as unresolved with no automatic retry; `not_dispatched` has a negative test and remains conversation-only; state/outbox writes and notification/consumption are atomic; worker table policies are explicit; insert conflicts are no-ops without repeated fan-out; visible feed polling is 30 seconds and Svix timestamp tolerance is ±300 seconds; line estimate is 650–900 and the one-PR-per-slice exception remains user-authorized.
- `uncertain` may lack a transaction hash, so the feed does not claim resolution. Any later chain observation is a separate canonical activity event; no automatic resend or unsupported linkage is attempted in this slice.

### Review output (Pi, verbatim finding summary)

> F1 — HIGH: `uncertain` may mean funds moved, but the old outline omitted it. Add it to notifications and tests.
>
> F2 — MEDIUM: a post-commit in-process hook can lose the notice on process crash. The final design chooses a transactional outbox.
>
> F3 — MEDIUM: applying user-isolation RLS to system worker tables blocks receipts and reconciliation. The final design keeps FORCE RLS with separate system-context policies.
>
> F4 — LOW: the concurrent insert loser must map the unique conflict to already canonical and avoid a second invalidation.
>
> F5 — LOW: name the feed polling interval and Svix timestamp tolerance. Final values: 30 seconds and ±300 seconds.
>
> F6 — INFORMATIONAL: original changed-line estimate undercounted tests. Updated estimate: 650–900 lines under the authorized one-PR-per-slice exception.
>
> `not_dispatched` returns the attempt to `previewed`; keep it notification-free and preserve the conversation error. The outline was not ready until F1/F3 and related design choices were resolved.

Review focus:

- Validate cursor ordering/retention and exactly-once notification semantics under concurrent poll/webhook ingestion.
- Challenge raw-body signature route registration and the separation between authenticated feed and unauthenticated signed provider ingress.
- Confirm RLS ownership, safe event projection, and supported inbound event scope.
- Identify a concrete local runtime harness and prevent scheduler/test flakiness.
- Check slice boundary, changed-line estimate, and rollback plan.
