-- Restore sequence-backed identifiers for IndividualTransaction entries
CREATE SEQUENCE IF NOT EXISTS "IndividualTransaction_transactionId_seq";

DO $$
DECLARE
  max_id BIGINT;
BEGIN
  SELECT MAX(substring("transactionId" FROM 3)::bigint)
  INTO max_id
  FROM "IndividualTransaction"
  WHERE "transactionId" ~ '^IT[0-9]+$';

  IF max_id IS NULL OR max_id < 1 THEN
    PERFORM setval('"IndividualTransaction_transactionId_seq"', 1, false);
  ELSE
    PERFORM setval('"IndividualTransaction_transactionId_seq"', max_id, true);
  END IF;
END $$;

ALTER TABLE "IndividualTransaction"
  ALTER COLUMN "transactionId"
  SET DEFAULT concat('IT', nextval('"IndividualTransaction_transactionId_seq"'::regclass));
