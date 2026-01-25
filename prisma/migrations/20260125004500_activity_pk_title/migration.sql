-- Make title the primary key and add type column on Activity
ALTER TABLE "Activity"
ADD COLUMN IF NOT EXISTS "type" TEXT;

ALTER TABLE "Activity"
DROP CONSTRAINT IF EXISTS "Activity_pkey";

ALTER TABLE "Activity"
DROP COLUMN IF EXISTS "id";

ALTER TABLE "Activity"
ADD CONSTRAINT "Activity_pkey" PRIMARY KEY ("title");
