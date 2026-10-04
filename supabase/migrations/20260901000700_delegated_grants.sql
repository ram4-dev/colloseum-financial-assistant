-- DGC-1: delegated grant core (Slice 1). Supabase-side migration (applied by CI
-- via psql). Local mirror: src/db/migrations/008_delegated_grants.sql.
-- Additive: does NOT alter user_wallets / signer_grants / wallet_operations.
-- D-7 baseline: multiple executions covered within cumulative cap + rolling
-- window until expiry/revocation. Amounts use NUMERIC(38,0) to hold Solana
-- lamports and future token decimals without float error.

CREATE TABLE IF NOT EXISTS public.delegated_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  wallet_id UUID NOT NULL,
  action TEXT NOT NULL DEFAULT 'transfer'
    CHECK (action IN ('transfer')),
  chain TEXT NOT NULL DEFAULT 'solana',
  max_per_transfer NUMERIC(38,0) NOT NULL CHECK (max_per_transfer > 0),
  max_cumulative NUMERIC(38,0) NOT NULL CHECK (max_cumulative > 0),
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked', 'expired')),
  provider_policy_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delegated_grants_caps_order_ck CHECK (max_per_transfer <= max_cumulative),
  CONSTRAINT delegated_grants_revoked_ck CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL) OR (state <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS delegated_grants_user_state_idx
  ON public.delegated_grants (user_id, state);
CREATE INDEX IF NOT EXISTS delegated_grants_wallet_idx
  ON public.delegated_grants (wallet_id);

-- Consumption claims: DB-level idempotency (DGC-3). One claim per
-- (grant, idempotency key); a replay must never double-consume.
CREATE TABLE IF NOT EXISTS public.grant_claim_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount NUMERIC(38,0) NOT NULL CONSTRAINT grant_claim_ledger_amount_positive_ck CHECK (amount > 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grant_claim_ledger_grant_idempotency_uk UNIQUE (grant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS grant_claim_ledger_grant_idx
  ON public.grant_claim_ledger (grant_id);

ALTER TABLE public.grant_claim_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grant_claim_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grant_claim_ledger_user_isolation ON public.grant_claim_ledger;
CREATE POLICY grant_claim_ledger_user_isolation ON public.grant_claim_ledger
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

REVOKE ALL ON public.grant_claim_ledger FROM PUBLIC;
GRANT SELECT, INSERT ON public.grant_claim_ledger TO recipient_app;

CREATE TABLE IF NOT EXISTS public.grant_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  event TEXT NOT NULL
    CHECK (event IN ('created', 'used', 'rejected', 'revoked', 'expired',
                     'policy_synced', 'policy_sync_failed')),
  reason TEXT,
  amount NUMERIC(38,0),
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grant_audit_log_grant_created_idx
  ON public.grant_audit_log (grant_id, created_at);
CREATE INDEX IF NOT EXISTS grant_audit_log_user_event_idx
  ON public.grant_audit_log (user_id, event);

-- Append-only enforcement: audit rows are immutable. Postgres lacks row-level
-- deny on UPDATE/DELETE for the owner, so we enforce with a guard trigger.
CREATE OR REPLACE FUNCTION public.grant_audit_log_append_only_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'grant_audit_log is append-only: % blocked', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS grant_audit_log_append_only ON grant_audit_log;
CREATE TRIGGER grant_audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.grant_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.grant_audit_log_append_only_guard();

ALTER TABLE delegated_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegated_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE grant_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delegated_grants_user_isolation ON delegated_grants;
CREATE POLICY delegated_grants_user_isolation ON delegated_grants
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS grant_audit_log_user_isolation ON grant_audit_log;
CREATE POLICY grant_audit_log_user_isolation ON public.grant_audit_log
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

REVOKE ALL ON public.delegated_grants FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.delegated_grants TO recipient_app;
REVOKE ALL ON public.grant_audit_log FROM PUBLIC;
GRANT SELECT, INSERT ON public.grant_audit_log TO recipient_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delegated_grants_user_id_users_fk') THEN
    ALTER TABLE delegated_grants ADD CONSTRAINT delegated_grants_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delegated_grants_wallet_id_wallets_fk') THEN
    ALTER TABLE delegated_grants ADD CONSTRAINT delegated_grants_wallet_id_wallets_fk
      FOREIGN KEY (wallet_id) REFERENCES public.user_wallets(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grant_audit_log_user_id_users_fk') THEN
    ALTER TABLE grant_audit_log ADD CONSTRAINT grant_audit_log_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grant_claim_ledger_user_id_users_fk') THEN
    ALTER TABLE public.grant_claim_ledger ADD CONSTRAINT grant_claim_ledger_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grant_claim_ledger_grant_id_grants_fk') THEN
    ALTER TABLE public.grant_claim_ledger ADD CONSTRAINT grant_claim_ledger_grant_id_grants_fk
      FOREIGN KEY (grant_id) REFERENCES public.delegated_grants(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grant_audit_log_grant_id_grants_fk') THEN
    ALTER TABLE grant_audit_log ADD CONSTRAINT grant_audit_log_grant_id_grants_fk
      FOREIGN KEY (grant_id) REFERENCES public.delegated_grants(id) NOT VALID;
  END IF;
END
$$;
