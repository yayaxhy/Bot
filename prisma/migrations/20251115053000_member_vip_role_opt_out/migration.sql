-- Rename spentRoleOptOut to VIPRoleOptOut (safe if already renamed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Member'
      AND column_name = 'spentRoleOptOut'
  ) THEN
    ALTER TABLE "Member"
    RENAME COLUMN "spentRoleOptOut" TO "VIPRoleOptOut";
  END IF;
END $$;
