-- Slice 4: saved recipients may opt into Solana devnet. NULL preserves the
-- existing EVM behavior for contacts created before chain scoping.
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS network TEXT;
ALTER TABLE recipient_versions ADD COLUMN IF NOT EXISTS network TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recipients_network_supported'
  ) THEN
    ALTER TABLE recipients
      ADD CONSTRAINT recipients_network_supported
      CHECK (network IS NULL OR network = 'solana-devnet');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recipient_versions_network_supported'
  ) THEN
    ALTER TABLE recipient_versions
      ADD CONSTRAINT recipient_versions_network_supported
      CHECK (network IS NULL OR network = 'solana-devnet');
  END IF;
END $$;
