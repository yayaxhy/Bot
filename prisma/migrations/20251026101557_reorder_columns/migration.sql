BEGIN;

-- 1) Add new columns in the order you want them to appear
ALTER TABLE "Gift" ADD COLUMN "price_new"     numeric(19,4);
ALTER TABLE "Gift" ADD COLUMN "url_new"  text;

-- 2) Copy data from the old columns
UPDATE "Gift"
SET "price_new"    = "price",
    "url_new" = "url";

-- 3) Drop the old columns (the first/old positions go away)
ALTER TABLE "Gift" DROP COLUMN "url";
ALTER TABLE "Gift" DROP COLUMN "price";

-- 4) Rename the new columns to the original names
ALTER TABLE "Gift" RENAME COLUMN "price_new"    TO "price";
ALTER TABLE "Gift" RENAME COLUMN "url_new" TO "url";

-- 5) (Optional) Reapply constraints/defaults if you had them
-- ALTER TABLE "Gift" ALTER COLUMN "price" SET NOT NULL;
-- ALTER TABLE "Gift" ALTER COLUMN "price" SET DEFAULT 0;

COMMIT;
