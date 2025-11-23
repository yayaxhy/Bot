-- Realign Withdraw_id_seq safely (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'Withdraw_id_seq'
  ) THEN
    CREATE SEQUENCE "Withdraw_id_seq";
  END IF;
END $$;

DO $$
DECLARE
  max_id BIGINT;
BEGIN
  SELECT MAX(substring("id" FROM 2)::bigint)
  INTO max_id
  FROM "Withdraw"
  WHERE "id" ~ '^W[0-9]+$';

  IF max_id IS NULL OR max_id < 1 THEN
    PERFORM setval('"Withdraw_id_seq"', 1, false);
  ELSE
    PERFORM setval('"Withdraw_id_seq"', max_id, true);
  END IF;
END $$;

-- Ensure default uses the sequence
ALTER TABLE "Withdraw"
  ALTER COLUMN "id"
  SET DEFAULT concat('W', nextval('"Withdraw_id_seq"'::regclass));
