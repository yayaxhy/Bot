-- Track ten-draw rounds with an atomic counter so recipe rotation works under concurrency.
CREATE TABLE "LotteryTenDrawCounter" (
  "id" INTEGER NOT NULL,
  "tenDrawCount" BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT "LotteryTenDrawCounter_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LotteryTenDrawCounter_single_row" CHECK ("id" = 1)
);

INSERT INTO "LotteryTenDrawCounter" ("id", "tenDrawCount")
VALUES (
  1,
  COALESCE((SELECT COUNT(*)::BIGINT FROM "LotteryDraw" WHERE "cost" = 290), 0)
);
