-- Create Activity table (id, title, description). Idempotent for re-runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'Activity') THEN
    CREATE TABLE "Activity" (
      "id" SERIAL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "description" TEXT
    );
  END IF;
END $$;

-- If an older version of the table exists, drop unused columns and index.
ALTER TABLE "Activity" DROP COLUMN IF EXISTS "active";
ALTER TABLE "Activity" DROP COLUMN IF EXISTS "createdAt";
ALTER TABLE "Activity" DROP COLUMN IF EXISTS "updatedAt";

DROP INDEX IF EXISTS "Activity_active_createdAt_idx";
