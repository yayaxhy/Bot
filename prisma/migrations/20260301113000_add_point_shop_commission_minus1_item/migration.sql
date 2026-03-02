-- Point shop item: 抽成降1%券（与抽奖同券类型）
INSERT INTO "PointShopItem" (
  "id",
  "sku",
  "name",
  "description",
  "pointsCost",
  "stock",
  "isActive",
  "deliveryType",
  "couponType",
  "couponExpireDays",
  "sortOrder",
  "createdAt",
  "updatedAt"
)
VALUES (
  concat('PSI', replace(gen_random_uuid()::text, '-', '')),
  'PS_COMMISSION_MINUS1_VOUCHER',
  '抽成降1%券',
  '与抽奖奖池同款：抽成降1%券',
  3000,
  NULL,
  TRUE,
  'COUPON'::"PointShopDeliveryType",
  'COMMISSION_MINUS1_VOUCHER'::"CouponType",
  30,
  220,
  NOW(),
  NOW()
)
ON CONFLICT ("sku") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "pointsCost" = EXCLUDED."pointsCost",
  "stock" = EXCLUDED."stock",
  "isActive" = EXCLUDED."isActive",
  "deliveryType" = EXCLUDED."deliveryType",
  "couponType" = EXCLUDED."couponType",
  "couponExpireDays" = EXCLUDED."couponExpireDays",
  "sortOrder" = EXCLUDED."sortOrder",
  "updatedAt" = NOW();
