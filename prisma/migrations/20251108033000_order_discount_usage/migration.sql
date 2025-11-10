CREATE TABLE "OrderDiscountUsage" (
  "orderId" TEXT PRIMARY KEY,
  "couponType" TEXT NOT NULL,
  "usedBy" TEXT NOT NULL,
  "discountAmount" DECIMAL(19,4) NOT NULL,
  "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
