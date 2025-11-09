DO $block$
BEGIN
  IF to_regclass('"PEIWAN"') IS NOT NULL
     AND to_regclass('"Member"') IS NOT NULL THEN

    CREATE OR REPLACE FUNCTION public.sync_peiwan_commission_to_member()
    RETURNS TRIGGER AS $fn$
    BEGIN
      IF NEW."commissionRate" IS DISTINCT FROM OLD."commissionRate" THEN
        UPDATE "Member"
           SET "commissionRate" = NEW."commissionRate"
         WHERE "discordUserId" = NEW."discordUserId";
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    IF EXISTS (
      SELECT 1
      FROM   pg_trigger t
      JOIN   pg_class   c ON c.oid = t.tgrelid
      WHERE  c.relname = 'PEIWAN'
      AND    t.tgname  = 'trg_sync_peiwan_commission'
    ) THEN
      EXECUTE 'DROP TRIGGER trg_sync_peiwan_commission ON "PEIWAN"';
    END IF;

    EXECUTE '
      CREATE TRIGGER trg_sync_peiwan_commission
      AFTER INSERT OR UPDATE OF "commissionRate" ON "PEIWAN"
      FOR EACH ROW
      EXECUTE FUNCTION public.sync_peiwan_commission_to_member()
    ';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_busy_worker
      ON "PEIWAN"("discordUserId")
      WHERE "status" = 'busy'::"PeiwanStatus";
  END IF;
END
$block$;
