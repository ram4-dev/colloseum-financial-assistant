# Slice 2 signer-binding decision

**Date:** 2026-10-04
**Scope:** architectural amendment only; no production code or tests changed.

## Finding

The composed-policy adapter cannot safely derive the Privy authorization signer
from `walletId`. `user_wallets` stores provider wallet id and address but no
signer id. `PRIVY_AUTHORIZATION_KEY_QUORUM_ID` identifies the enrollment quorum,
not the wallet's `additional_signers[].signer_id` (existing tests model different
values). Choosing `additional_signers[0]` could attach policy to the wrong
authority.

`signer_grants.provider_signer_id` contains trusted readback evidence from the
older enrollment flow, but an active row is not stable wallet identity: grant
revocation changes lifecycle state without proving the signer disappeared, and
multiple historical rows can conflict. It would also couple the new delegated
grant ledger to a separate permission lifecycle.

## Decision

Persist the canonical provider signer on the wallet binding:

```text
user_wallets.provider_signer_id TEXT NULL
```

Write it only after server readback identifies exactly one Privy additional
signer carrying the enrollment policy. Policy code resolves the local wallet
UUID to `{providerWalletId, providerSignerId}` before mutation, then selects
exactly one remote signer with that id. Zero, duplicate, or drifted matches fail
closed; list position and quorum id are never fallbacks.

Every financial caller must also propagate chain intent. Wallet HTTP routes,
conversation execution, and LiveKit-bound providers derive `solana` or `evm`
from the requested network and pass it to `WalletForUser`; missing or unknown
intent cannot default to EVM in a multi-chain resolver.

## Migration and rollout

Add the nullable column to local and Supabase migration chains. Backfill only
wallets for which all non-null, previously readback-derived
`signer_grants.provider_signer_id` values have one distinct value. No evidence
or conflicting evidence leaves NULL. Enrollment completion persists future
bindings after exact readback.

Enable the Solana selector only after migration and readback verification.
Existing NULL rows remain `policy_not_ready` until verified enrollment/readback
repairs them. Rollback disables the selector; the additive column may remain.

## Options rejected

| Option | Rejection |
| --- | --- |
| First `additional_signers` entry | Provider ordering is not identity. |
| Authorization quorum id | Quorum id and wallet signer id are distinct contracts. |
| Active `signer_grants` lookup | Couples identity to mutable grant lifecycle and cannot resolve conflicting history. |
| Global signer-id env | Weakens per-wallet verification and duplicates provider state. |

## Task-planning inputs

1. RED tests prove no create/attach/PATCH for NULL, conflicting,
   remote-missing, or duplicate signer identity.
2. Migration tests cover zero, one, repeated-equal, and conflicting historical
   signer ids.
3. Enrollment integration proves readback persists the signer id.
4. Policy admin interfaces accept the exact provider wallet/signer tuple and
   verify that same signer after mutation.
5. HTTP, conversation, and LiveKit tests prove network-to-chain propagation and
   fail closed for missing/unknown hints.
6. Audit/metrics distinguish binding absence, ambiguous history, remote drift,
   provider mutation failure, readback mismatch, and routing failure.

## Residual risks

- Existing wallets without unique historical evidence require fresh verified
  enrollment/readback before delegated execution.
- Remote signer replacement intentionally causes an outage until the canonical
  binding is re-established; automatic signer switching is forbidden.
- Privy's Solana signer readback shape remains a live-smoke gate before rollout.
