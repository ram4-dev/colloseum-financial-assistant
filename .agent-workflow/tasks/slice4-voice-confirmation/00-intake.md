# Slice 4 intake: explicit voice confirmation outside authorization

## Selected workflow

RPI, as the task is finite but depends on reviewing the current LiveKit, provider, and conversation paths before agreeing on an integrated design. SDD is the implementation route required by repository policy. Ramiro's standing instruction authorizes Slices 2–5 in order without additional approval pauses; implementation remains bound to this slice's scope and its SDD.

## Objective

For a Solana devnet transfer that is not covered by an active delegated grant, the voice session must present a durable preview with amount, recipient, and fee, then broadcast only after an explicit spoken confirmation. Spoken cancellation and stale-preview handling must remain safe and observable.

## Boundaries

In scope: LiveKit transcript-to-preview/decision path; explicit spoken confirm/cancel; Solana address and policy validation for the voice transfer path; stale-preview behavior, audit/attempt semantics, narration, tests and required agent evals if the agent prompt/tool surface changes.

Out of scope: creating or changing grants by voice, execution without reconfirmation under covered grants (Slice 3), multi-wallet, swaps, notifications, and broad wallet UI or HTTP-contract redesign.

## Acceptance evidence

- A non-covered Solana devnet voice request produces a preview and does not broadcast.
- The spoken confirmation resolves only the stored preview and broadcasts once; cancellation does not broadcast.
- Expired, stale, malformed, mismatched, or unsupported requests remain closed and use the established preview/error behavior.
- The realtime/model tool cannot choose a free-form destination or bypass explicit confirmation.
- Fixture E2E exercises spoken confirm and cancel without live credentials; targeted evals run if agent instructions or tools change.

## Worktree

- Branch: `slice4-voice-confirmation`
- Path: `/Users/ramiro/Desktop/projects/colloseum.slice4-voice-confirmation`
- Base: `origin/slice3-grant-execution` at `26a8098`
