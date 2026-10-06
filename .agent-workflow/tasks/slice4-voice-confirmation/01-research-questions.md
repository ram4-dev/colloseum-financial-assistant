# Slice 4 research questions

1. What exact path handles final voice transcripts, pending preview decisions, and the transition to broadcast/finality? Which behavior already exists and what is missing for Solana?
2. Which realtime tools can create a transfer preview, what inputs are strict or server-derived, and can model output bypass the explicit-confirm boundary?
3. Where is transfer policy/address validation EVM-specific, and which Solana devnet validation/provider path from Slice 2 can be reused without widening signing authority?
4. How are stale previews, cancellation, retries, leases, and audit/attempt state represented and tested today?
5. Which narration and voice evals cover preview amount, destination, fee, spoken confirmation/cancellation, and failure states?
6. What minimal files and tests can deliver the observable behavior without changing grant issuance, swaps, multi-wallet, notifications, or the HTTP contract?
