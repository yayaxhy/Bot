-- Harden the guard so totalBalance cannot be edited independently
CREATE OR REPLACE FUNCTION "ensure_member_balance_consistency"()
RETURNS trigger AS $$
DECLARE
  expected NUMERIC(19, 4);
BEGIN
  expected := COALESCE(NEW."income", 0) + COALESCE(NEW."recharge", 0);

  IF TG_OP = 'UPDATE'
     AND NEW."totalBalance" IS DISTINCT FROM expected
     AND (NEW."income" IS NOT DISTINCT FROM OLD."income")
     AND (NEW."recharge" IS NOT DISTINCT FROM OLD."recharge") THEN
    RAISE EXCEPTION
      USING MESSAGE = 'totalBalance is derived from income + recharge and cannot be modified directly.';
  END IF;

  NEW."totalBalance" := expected;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
