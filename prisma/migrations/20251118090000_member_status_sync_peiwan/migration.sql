-- Ensure members that already have a PEIWAN row are marked as PEIWAN
UPDATE "Member"
SET "status" = 'PEIWAN'::"MemberStatus"
WHERE "discordUserId" IN (SELECT "discordUserId" FROM "PEIWAN");

-- Keep member status in sync whenever a PEIWAN profile is inserted or reassigned
CREATE OR REPLACE FUNCTION "sync_member_status_on_peiwan"()
RETURNS trigger AS $$
BEGIN
  UPDATE "Member"
  SET "status" = 'PEIWAN'::"MemberStatus"
  WHERE "discordUserId" = NEW."discordUserId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "peiwan_member_status_sync" ON "PEIWAN";
CREATE TRIGGER "peiwan_member_status_sync"
AFTER INSERT OR UPDATE OF "discordUserId"
ON "PEIWAN"
FOR EACH ROW
EXECUTE FUNCTION "sync_member_status_on_peiwan"();
