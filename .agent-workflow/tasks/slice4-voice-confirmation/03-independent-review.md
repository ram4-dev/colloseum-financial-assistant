# Independent outline review

Date: 2026-10-05. Reviewer: Pi `nan/glm5.3-flash`, reasoning high, separate Herdr pane/session from research and implementation.

## Initial review

Result: FAIL, with one authorization blocker and two smaller gaps.

- B1: transcript evidence was armed after preview persistence but could precede the user's hearing the preview. The model's prompt-level narration request was not server authorization.
- The source and units of the live maximum needed to be explicit and separate from Slice 2's grant-only 0.01 SOL limit.
- The outline needed to rule out a second generic transcript route that could resolve the same user phrase outside the voice evidence gate.

## Remediation

- Require worker-controlled `AgentSession.say` narration of exact amount, saved name, token/network and estimated fee; await uninterrupted playout before arming evidence for the persisted preview ID. Ignore early/interim/interrupted confirmation.
- State that Solana voice uses `WDK_MAX_TRANSFER_AMOUNT` exactly in SOL and exact lamport conversion without an oracle. The 10,000,000-lamport cap stays specific to delegated grants.
- Route session transcripts only into the one-use voice decision gate; do not also pass decision transcripts through `RoomConversation.handleFinalTranscript` or generic `handleTurnStream`.
- Add explicit fail-closed speaker identity, provider idempotency ID, Solana explorer projection, narration/interruption ordering, and no-double-route tests.

## Final re-review

Result: **PASS — no blockers remaining.** Pi confirmed the B1 safety blocker and both smaller gaps were resolved. It recommended making the spoken-cancellation playout condition explicit and naming `WDK_MAX_TRANSFER_AMOUNT` in the at-or-below-maximum scenario; both clarifications were applied to the spec after review.

Reviewer verified against source: `confirm_transfer` previously had no transcript evidence; `UserInputTranscribed` is available in the installed LiveKit SDK; contact records are EVM-only today; the configured live maximum is decimal SOL for the Solana path; the grant-only cap is stored in lamports; and terminal conversation state previously hardcoded Etherscan.

Reviewer session: `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.slice4-voice-confirmation--/2026-10-05T07-12-23-261Z_01a10ae8-10dd-7762-937e-4cfeef476ede.jsonl` (`w5:t2J` / `w5:p4H`).
