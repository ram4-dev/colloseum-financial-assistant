-- 013_wallet_notifications.sql
-- Slice 5: durable wallet and assistant notifications.
-- Additive migration only: new tables, indexes, grants, and table-specific RLS.
-- Existing transfer authorization and conversation tables are untouched.

-- ---------------------------------------------------------------------------
-- wallet_notifications: user-scoped canonical feed rows.
-- Identity: (user_id, dedupe_key) — one canonical notification per event.
-- ---------------------------------------------------------------------------

CREATE TABLE public.wallet_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  wallet_id UUID,
  conversation_id UUID,
  operation_id UUID,
  category TEXT NOT NULL CHECK (category IN ('assistant_transfer', 'wallet_event')),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'uncertain', 'confirmed', 'reverted', 'receipt_invalid', 'deposit')),
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  explanation TEXT,
  resolved BOOLEAN NOT NULL DEFAULT true,
  projection JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

-- Canonical dedupe identity: one notification per (user, dedupe key).
CREATE UNIQUE INDEX wallet_notifications_user_dedupe_key_idx
  ON public.wallet_notifications (user_id, dedupe_key);
CREATE INDEX wallet_notifications_user_created_idx
  ON public.wallet_notifications (user_id, created_at DESC);
CREATE INDEX wallet_notifications_wallet_idx
  ON public.wallet_notifications (wallet_id);

-- ---------------------------------------------------------------------------
-- assistant_lifecycle_outbox: transactional outbox rows written in the same
-- transaction as each notification-worthy conversation_transfer_attempts
-- state transition. Dispatched through canonical ingestion; notification
-- insertion and outbox completion commit atomically.
-- ---------------------------------------------------------------------------

CREATE TABLE public.assistant_lifecycle_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL,
  user_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'uncertain', 'confirmed', 'reverted', 'receipt_invalid')),
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- One outbox event per attempt state; dispatcher retries until processed.
CREATE UNIQUE INDEX assistant_lifecycle_outbox_attempt_status_idx
  ON public.assistant_lifecycle_outbox (attempt_id, status);
CREATE INDEX assistant_lifecycle_outbox_pending_idx
  ON public.assistant_lifecycle_outbox (created_at)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- provider_webhook_receipts: scoped delivery-ID dedupe for signed webhooks.
-- System-context-only: never user feed data.
-- ---------------------------------------------------------------------------

CREATE TABLE public.provider_webhook_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX provider_webhook_receipts_scoped_delivery_idx
  ON public.provider_webhook_receipts (provider, account_id, delivery_id);

-- ---------------------------------------------------------------------------
-- reconciliation_cursors: persisted per-wallet/network progress with
-- overlap-safe paging. One active cursor row per (wallet, network).
-- ---------------------------------------------------------------------------

CREATE TABLE public.reconciliation_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  network TEXT NOT NULL,
  cursor_value TEXT,
  last_confirmed_signature TEXT,
  -- Forward catch-up state: highest (newest) signature observed in the gap
  -- between cursor_value and now; drained page-by-page via scan_cursor using
  -- before=scan_cursor / until=cursor_value. cursor_value advances to
  -- scan_high_watermark only when the gap is fully drained (lossless).
  scan_high_watermark TEXT,
  scan_cursor TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX reconciliation_cursors_wallet_network_idx
  ON public.reconciliation_cursors (wallet_id, network);

-- ---------------------------------------------------------------------------
-- reconciliation_leases: DB-backed worker exclusion; one active run per
-- (wallet, network). acquire_reconciliation_lease returns a token for the
-- caller or NULL when another worker holds the lease.
-- ---------------------------------------------------------------------------

CREATE TABLE public.reconciliation_leases (
  wallet_id UUID NOT NULL,
  network TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (wallet_id, network)
);

CREATE OR REPLACE FUNCTION public.acquire_reconciliation_lease(
  p_wallet_id UUID,
  p_network TEXT,
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 300
) RETURNS TABLE (lease_token TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_token TEXT;
BEGIN
  -- Expired lease rows are reclaimable by any worker.
  DELETE FROM public.reconciliation_leases
  WHERE wallet_id = p_wallet_id
    AND network = p_network
    AND expires_at <= now();

  -- Insert a fresh lease, or reclaim only an expired row on conflict.
  -- When another worker holds a live lease, the WHERE skips the update and
  -- no row is produced: the caller receives NULL (excluded). Column
  -- references are table-qualified to avoid clashing with the RETURNS
  -- TABLE(lease_token) OUT variable inside plpgsql.
  WITH upserted AS (
    INSERT INTO public.reconciliation_leases AS existing
      (wallet_id, network, lease_token, worker_id, acquired_at, expires_at)
    VALUES (
      p_wallet_id, p_network,
      md5(random()::text || clock_timestamp()::text || p_worker_id),
      p_worker_id, now(), now() + make_interval(secs => p_lease_seconds)
    )
    ON CONFLICT (wallet_id, network) DO UPDATE
      SET lease_token = md5(random()::text || clock_timestamp()::text || p_worker_id),
          worker_id = EXCLUDED.worker_id,
          acquired_at = now(),
          expires_at = now() + make_interval(secs => p_lease_seconds)
      WHERE existing.expires_at <= now()
    RETURNING existing.lease_token AS granted_token
  )
  SELECT granted_token INTO v_token FROM upserted;

  RETURN QUERY SELECT v_token;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Notification feed rows: owner-only through the app.user_id transaction
-- guard. Ingestion tables (receipts, cursors, leases) are
-- system-context-only: policies allow access only when no app.user_id is
-- set (anonymous server-worker transactions) and deny every user context.
-- The outbox serves both paths: attempt transitions insert from the owner's
-- user transaction, and the dispatcher enumerates pending rows anonymously.
-- ---------------------------------------------------------------------------

ALTER TABLE public.wallet_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_lifecycle_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_lifecycle_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provider_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_webhook_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_leases FORCE ROW LEVEL SECURITY;

-- Owner-only feed access; system (anonymous) context matches no row.
CREATE POLICY wallet_notifications_user_isolation ON public.wallet_notifications
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- System-context guard shared by system-only ingestion tables.
-- current_setting('app.user_id', true) is NULL outside a user transaction.
CREATE POLICY provider_webhook_receipts_system_only ON public.provider_webhook_receipts
  FOR ALL
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');

CREATE POLICY reconciliation_cursors_system_only ON public.reconciliation_cursors
  FOR ALL
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');

CREATE POLICY reconciliation_leases_system_only ON public.reconciliation_leases
  FOR ALL
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');

-- Outbox: the resolved owner's transaction writes attempt transitions;
-- anonymous system context enumerates pending events for the dispatcher.
CREATE POLICY assistant_lifecycle_outbox_user_isolation ON public.assistant_lifecycle_outbox
  FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY assistant_lifecycle_outbox_system_access ON public.assistant_lifecycle_outbox
  FOR ALL
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wallet_notifications TO recipient_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_lifecycle_outbox TO recipient_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_webhook_receipts TO recipient_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_cursors TO recipient_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_leases TO recipient_app;
GRANT EXECUTE ON FUNCTION public.acquire_reconciliation_lease(UUID, TEXT, TEXT, INTEGER) TO recipient_app;

-- ---------------------------------------------------------------------------
-- Slice 5 system identity lookup: the webhook ingress must resolve the local
-- enrollment (wallet owner) from a verified provider account while running in
-- system context. Migration 006 leaves user_wallets owner-scoped only, so
-- anonymous system transactions see zero rows. This additive policy grants
-- read access ONLY when no user context is set (server worker); owner
-- isolation for user transactions is unchanged.
-- ---------------------------------------------------------------------------

CREATE POLICY user_wallets_system_identity_lookup ON public.user_wallets
  FOR SELECT TO recipient_app
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');
