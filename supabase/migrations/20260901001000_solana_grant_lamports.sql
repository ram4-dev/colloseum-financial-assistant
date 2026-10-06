-- Slice 2: keep Solana's native per-transfer amount in lamports without
-- changing the existing EVM atomic6 amount or its semantics.
ALTER TABLE public.signer_grants
  ADD COLUMN IF NOT EXISTS per_transfer_lamports TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signer_grants_per_transfer_lamports_nonnegative'
      AND conrelid = 'public.signer_grants'::regclass
  ) THEN
    ALTER TABLE public.signer_grants
      ADD CONSTRAINT signer_grants_per_transfer_lamports_nonnegative
      CHECK (per_transfer_lamports IS NULL OR per_transfer_lamports ~ '^[0-9]+$');
  END IF;
END $$;
