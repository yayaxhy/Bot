-- Ensure Coupon, Recharge, and Withdraw IDs use database sequences

-- Coupon IDs
CREATE SEQUENCE IF NOT EXISTS "Coupon_id_seq";

DO $$
DECLARE
  max_id BIGINT;
BEGIN
  SELECT MAX(substring("id" FROM 2)::bigint)
  INTO max_id
  FROM "Coupon"
  WHERE "id" ~ '^C[0-9]+$';

  IF max_id IS NULL OR max_id < 1 THEN
    PERFORM setval('"Coupon_id_seq"', 1, false);
  ELSE
    PERFORM setval('"Coupon_id_seq"', max_id, true);
  END IF;
END $$;

ALTER TABLE "Coupon"
  ALTER COLUMN "id"
  SET DEFAULT concat('C', nextval('"Coupon_id_seq"'::regclass));

-- Recharge IDs
CREATE SEQUENCE IF NOT EXISTS "Recharge_RechargeID_seq";

DO $$
DECLARE
  max_id BIGINT;
BEGIN
  SELECT MAX(substring("RechargeID" FROM 2)::bigint)
  INTO max_id
  FROM "Recharge"
  WHERE "RechargeID" ~ '^C[0-9]+$';

  IF max_id IS NULL OR max_id < 1 THEN
    PERFORM setval('"Recharge_RechargeID_seq"', 1, false);
  ELSE
    PERFORM setval('"Recharge_RechargeID_seq"', max_id, true);
  END IF;
END $$;

ALTER TABLE "Recharge"
  ALTER COLUMN "RechargeID"
  SET DEFAULT concat('C', nextval('"Recharge_RechargeID_seq"'::regclass));

-- Withdraw IDs
CREATE SEQUENCE IF NOT EXISTS "Withdraw_id_seq";

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

ALTER TABLE "Withdraw"
  ALTER COLUMN "id"
  SET DEFAULT concat('W', nextval('"Withdraw_id_seq"'::regclass));
