-- 20260901000900_canonical_signer_binding.sql — task 2.7: canonical Privy
-- signer binding (Supabase chain; mirrors src/db/migrations/010_canonical_signer_binding.sql).
--
-- Adds the nullable `public.user_wallets.provider_signer_id` canonical binding
-- and durable pending-enrollment snapshot on `public.signer_grants` (the
-- existing provider_signer_id there remains the historical evidence), then
-- backfills the wallet binding conservatively from signer_grants evidence:
--   - only wallets whose DISTINCT non-null signer_grants.provider_signer_id
--     values count EXACTLY ONE are backfilled (zero or conflicting stay NULL);
--   - the UPDATE guards on IS NULL, so an existing canonical binding (or a
--     concurrent enrollment write) is never rewritten;
--   - NULL rows stay inert until verified enrollment/readback repairs them.

ALTER TABLE public.user_wallets
  ADD COLUMN IF NOT EXISTS provider_signer_id TEXT;

ALTER TABLE public.signer_grants
  ADD COLUMN IF NOT EXISTS signer_enrollment_snapshot JSONB;

DO $$
DECLARE
  wallet_row RECORD;
  evidence_count INT;
  evidence_signer TEXT;
BEGIN
  FOR wallet_row IN
    SELECT id FROM public.user_wallets
    WHERE provider_signer_id IS NULL
    FOR UPDATE
  LOOP
    SELECT COUNT(DISTINCT provider_signer_id), MIN(provider_signer_id)
      INTO evidence_count, evidence_signer
      FROM public.signer_grants
     WHERE wallet_id = wallet_row.id
       AND provider_signer_id IS NOT NULL;

    IF evidence_count = 1 THEN
      UPDATE public.user_wallets
         SET provider_signer_id = evidence_signer, updated_at = now()
       WHERE id = wallet_row.id AND provider_signer_id IS NULL;
    END IF;
    -- evidence_count = 0 -> left NULL; > 1 -> conflicted, never guess.
  END LOOP;
END $$;
