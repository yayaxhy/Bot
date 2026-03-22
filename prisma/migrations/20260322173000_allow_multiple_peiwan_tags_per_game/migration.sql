DROP INDEX IF EXISTS "PeiwanGameProfile_peiwanId_gameCode_key";

CREATE UNIQUE INDEX IF NOT EXISTS "PeiwanGameProfile_peiwanId_sourceRoleId_key"
  ON "PeiwanGameProfile"("peiwanId", "sourceRoleId");
