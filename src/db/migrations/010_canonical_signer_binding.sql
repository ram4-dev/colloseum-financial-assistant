-- 010_canonical_signer_binding.sql — task 2.7: canonical Privy signer binding.
-- Local mirror of supabase/migrations/20260901000900_canonical_signer_binding.sql
-- (the supabase chain owns the `public.` prefix; this runner sets
-- search_path = public, extensions).
--
-- Adds the nullable `user_wallets.provider_signer_id` canonical binding (the
-- column exists on signer_grants since 006 but NOT yet on user_wallets) and
-- durable pending-enrollment snapshot plus the canonical binding, and
-- backfills the binding conservatively from historical signer_grants evidence:
--   - only wallets whose DISTINCT non-null signer_grants.provider_signer_id
--     values count EXACTLY ONE are backfilled (zero or conflicting stay NULL);
--   - the UPDATE guards on IS NULL, so an existing canonical binding (or a
--     concurrent enrollment write) is never rewritten;
-- The column is additive/nullable; rollback is disabling the selector.

ALTER TABLE user_wallets
  ADD COLUMN IF NOT EXISTS provider_signer_id TEXT;

ALTER TABLE signer_grants
  ADD COLUMN IF NOT EXISTS signer_enrollment_snapshot JSONB;

DO $$
DECLARE
  wallet_row RECORD;
  evidence_count INT;
  evidence_signer TEXT;
BEGIN
  FOR wallet_row IN
    SELECT id FROM user_wallets
    WHERE provider_signer_id IS NULL
    FOR UPDATE
  LOOP
    SELECT COUNT(DISTINCT provider_signer_id), MIN(provider_signer_id)
      INTO evidence_count, evidence_signer
      FROM signer_grants
     WHERE wallet_id = wallet_row.id
       AND provider_signer_id IS NOT NULL;

    IF evidence_count = 1 THEN
      UPDATE user_wallets
         SET provider_signer_id = evidence_signer, updated_at = now()
       WHERE id = wallet_row.id AND provider_signer_id IS NULL;
    END IF;
    -- evidence_count = 0 -> left NULL; > 1 -> conflicted, never guess.
  END LOOP;
END $$;
