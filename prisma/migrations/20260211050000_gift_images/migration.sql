-- Gift wall image files (local storage)
CREATE TABLE IF NOT EXISTS "GiftImage" (
    "giftName" TEXT PRIMARY KEY,
    "fileName" TEXT NOT NULL,
    "uploadedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "GiftImage_giftName_fkey" FOREIGN KEY ("giftName") REFERENCES "Gift"("GiftName") ON DELETE CASCADE ON UPDATE CASCADE
);
