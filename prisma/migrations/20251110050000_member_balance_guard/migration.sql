-- Normalize any historic rows before installing the trigger
UPDATE "Member"
SET "totalBalance" = COALESCE("income", 0) + COALESCE("recharge", 0)
WHERE "totalBalance" IS DISTINCT FROM (COALESCE("income", 0) + COALESCE("recharge", 0));

-- Keep totalBalance equal to income + recharge for every write
CREATE OR REPLACE FUNCTION "ensure_member_balance_consistency"()
RETURNS trigger AS $$
BEGIN
  NEW."totalBalance" := COALESCE(NEW."income", 0) + COALESCE(NEW."recharge", 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "member_balance_consistency" ON "Member";
CREATE TRIGGER "member_balance_consistency"
BEFORE INSERT OR UPDATE OF "income", "recharge", "totalBalance"
ON "Member"
FOR EACH ROW
EXECUTE FUNCTION "ensure_member_balance_consistency"();
