-- DGC-8.7 (R4) upgrade path: enforce a positive claim amount on grant_claim_ledger
-- for databases where migration 20260901000700 was already applied (CREATE TABLE
-- IF NOT EXISTS does not add the CHECK to existing tables). Fresh installs get
-- the constraint from 20260901000700 itself, which names its inline CHECK
-- identically, so this guard finds it present and is a true no-op there
-- (no duplicate).
-- Named constraint: grant_claim_ledger_amount_positive_ck
-- NOTE: 20260901000700 names its inline CHECK identically, so on fresh installs
-- this guard finds the constraint present and is a true no-op (no duplicate).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'grant_claim_ledger_amount_positive_ck'
      AND conrelid = 'public.grant_claim_ledger'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE public.grant_claim_ledger
      ADD CONSTRAINT grant_claim_ledger_amount_positive_ck CHECK (amount > 0) NOT VALID;
  END IF;
END;
$$;
