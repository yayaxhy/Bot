DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumlabel = 'Q9'
      AND enumtypid = '"QuotationCode"'::regtype
  ) THEN
    ALTER TYPE "QuotationCode" ADD VALUE 'Q9';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumlabel = 'Q10'
      AND enumtypid = '"QuotationCode"'::regtype
  ) THEN
    ALTER TYPE "QuotationCode" ADD VALUE 'Q10';
  END IF;
END $$;

ALTER TABLE "PEIWAN"
ADD COLUMN IF NOT EXISTS "tftPrice" DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS "steamPrice" DECIMAL(10,2);