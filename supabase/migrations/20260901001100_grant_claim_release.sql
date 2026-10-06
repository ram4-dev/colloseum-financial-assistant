-- Slice 3 Phase 8 (AD-10): grant budget claims become RESERVATIONS released
-- on definitive no-dispatch. Additive: released_at/released_reason on
-- grant_claim_ledger mark a released reservation (NULL = held); the audit
-- event CHECK gains 'released' for the compensating audit row; UPDATE grant
-- on the claim table lets the user-scoped settlement (SET LOCAL ROLE
-- recipient_app) CAS the exact row. Forced RLS user-isolation policies from
-- 20260901000700_delegated_grants.sql are unchanged and continue to apply.
-- Local runner mirror: src/db/migrations/012_grant_claim_release.sql
-- (the supabase chain owns the `public.` prefix; the local runner sets
-- search_path = public, extensions).

ALTER TABLE public.grant_claim_ledger
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE public.grant_claim_ledger
  ADD COLUMN IF NOT EXISTS released_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'grant_audit_log_event_check'
      AND conrelid = 'public.grant_audit_log'::regclass
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'grant_audit_log_event_check not found: cannot extend the audit event CHECK';
  END IF;
END;
$$;

ALTER TABLE public.grant_audit_log DROP CONSTRAINT grant_audit_log_event_check;
ALTER TABLE public.grant_audit_log ADD CONSTRAINT grant_audit_log_event_check
  CHECK (event IN ('created', 'used', 'rejected', 'revoked', 'expired',
                   'policy_synced', 'policy_sync_failed', 'released'));

GRANT UPDATE ON public.grant_claim_ledger TO recipient_app;
