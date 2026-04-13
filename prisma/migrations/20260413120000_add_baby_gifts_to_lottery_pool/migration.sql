-- Add four baby gifts into the lottery pool.
-- Keep them in the ADVANCED pool with fixed weights and unlimited stock.

UPDATE "LotteryPrize"
SET
  "pool" = 'ADVANCED',
  "type" = 'GIFT',
  "weight" = 50,
  "unlimited" = true,
  "stock" = NULL,
  "active" = true
WHERE "name" IN ('兔兔宝宝', '狐狸宝宝', '猪猪宝宝', '小鸡宝宝');

INSERT INTO "LotteryPrize" ("id", "name", "pool", "type", "weight", "unlimited", "stock", "active")
SELECT 'lottery_rabbit_baby', '兔兔宝宝', 'ADVANCED', 'GIFT', 50, true, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM "LotteryPrize" WHERE "name" = '兔兔宝宝'
);

INSERT INTO "LotteryPrize" ("id", "name", "pool", "type", "weight", "unlimited", "stock", "active")
SELECT 'lottery_fox_baby', '狐狸宝宝', 'ADVANCED', 'GIFT', 50, true, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM "LotteryPrize" WHERE "name" = '狐狸宝宝'
);

INSERT INTO "LotteryPrize" ("id", "name", "pool", "type", "weight", "unlimited", "stock", "active")
SELECT 'lottery_piggy_baby', '猪猪宝宝', 'ADVANCED', 'GIFT', 50, true, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM "LotteryPrize" WHERE "name" = '猪猪宝宝'
);

INSERT INTO "LotteryPrize" ("id", "name", "pool", "type", "weight", "unlimited", "stock", "active")
SELECT 'lottery_chick_baby', '小鸡宝宝', 'ADVANCED', 'GIFT', 50, true, NULL, true
WHERE NOT EXISTS (
  SELECT 1 FROM "LotteryPrize" WHERE "name" = '小鸡宝宝'
);
