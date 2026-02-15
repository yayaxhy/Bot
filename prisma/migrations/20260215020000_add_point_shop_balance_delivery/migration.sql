-- Point shop: support auto balance-credit delivery

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointShopDeliveryType') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'PointShopDeliveryType'
        AND e.enumlabel = 'BALANCE'
    ) THEN
      ALTER TYPE "PointShopDeliveryType" ADD VALUE 'BALANCE';
    END IF;
  END IF;
END $$;

ALTER TABLE "PointShopItem"
  ADD COLUMN IF NOT EXISTS "balanceCreditAmount" DECIMAL(19,4);
