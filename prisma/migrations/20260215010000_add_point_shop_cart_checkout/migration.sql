-- Point shop: cart + checkout + point ledger

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointShopCartStatus') THEN
    CREATE TYPE "PointShopCartStatus" AS ENUM ('OPEN', 'CHECKED_OUT', 'ABANDONED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointShopOrderStatus') THEN
    CREATE TYPE "PointShopOrderStatus" AS ENUM ('SUCCESS', 'FAILED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointShopDeliveryType') THEN
    CREATE TYPE "PointShopDeliveryType" AS ENUM ('COUPON', 'MANUAL');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointShopDeliveryStatus') THEN
    CREATE TYPE "PointShopDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointShopPointLedgerType') THEN
    CREATE TYPE "PointShopPointLedgerType" AS ENUM ('DEBIT', 'CREDIT', 'ADJUST');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PointShopItem" (
  "id" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "pointsCost" DECIMAL(19,4) NOT NULL,
  "stock" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "deliveryType" "PointShopDeliveryType" NOT NULL DEFAULT 'COUPON',
  "couponType" "CouponType",
  "couponExpireDays" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointShopItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PointShopItem_sku_key" ON "PointShopItem"("sku");
CREATE INDEX IF NOT EXISTS "PointShopItem_isActive_sortOrder_idx" ON "PointShopItem"("isActive", "sortOrder");

CREATE TABLE IF NOT EXISTS "PointShopCart" (
  "id" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "status" "PointShopCartStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "checkedOutAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointShopCart_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PointShopCart_discordUserId_status_updatedAt_idx"
  ON "PointShopCart"("discordUserId", "status", "updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCart_discordUserId_fkey'
  ) THEN
    ALTER TABLE "PointShopCart"
      ADD CONSTRAINT "PointShopCart_discordUserId_fkey"
      FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PointShopCartItem" (
  "id" TEXT NOT NULL,
  "cartId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPoints" DECIMAL(19,4) NOT NULL,
  "itemNameSnapshot" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointShopCartItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PointShopCartItem_cartId_itemId_key" ON "PointShopCartItem"("cartId", "itemId");
CREATE INDEX IF NOT EXISTS "PointShopCartItem_cartId_createdAt_idx" ON "PointShopCartItem"("cartId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCartItem_cartId_fkey'
  ) THEN
    ALTER TABLE "PointShopCartItem"
      ADD CONSTRAINT "PointShopCartItem_cartId_fkey"
      FOREIGN KEY ("cartId") REFERENCES "PointShopCart"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCartItem_itemId_fkey'
  ) THEN
    ALTER TABLE "PointShopCartItem"
      ADD CONSTRAINT "PointShopCartItem_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "PointShopItem"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PointShopOrder" (
  "id" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "cartId" TEXT,
  "requestKey" TEXT NOT NULL,
  "status" "PointShopOrderStatus" NOT NULL DEFAULT 'SUCCESS',
  "totalPoints" DECIMAL(19,4) NOT NULL,
  "totalItems" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointShopOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PointShopOrder_discordUserId_requestKey_key" ON "PointShopOrder"("discordUserId", "requestKey");
CREATE INDEX IF NOT EXISTS "PointShopOrder_discordUserId_createdAt_idx" ON "PointShopOrder"("discordUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "PointShopOrder_cartId_idx" ON "PointShopOrder"("cartId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopOrder_discordUserId_fkey'
  ) THEN
    ALTER TABLE "PointShopOrder"
      ADD CONSTRAINT "PointShopOrder_discordUserId_fkey"
      FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopOrder_cartId_fkey'
  ) THEN
    ALTER TABLE "PointShopOrder"
      ADD CONSTRAINT "PointShopOrder_cartId_fkey"
      FOREIGN KEY ("cartId") REFERENCES "PointShopCart"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PointShopOrderItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "itemId" TEXT,
  "itemSku" TEXT NOT NULL,
  "itemName" TEXT NOT NULL,
  "unitPoints" DECIMAL(19,4) NOT NULL,
  "quantity" INTEGER NOT NULL,
  "subtotalPoints" DECIMAL(19,4) NOT NULL,
  "deliveryStatus" "PointShopDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "deliveryNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointShopOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PointShopOrderItem_orderId_createdAt_idx" ON "PointShopOrderItem"("orderId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopOrderItem_orderId_fkey'
  ) THEN
    ALTER TABLE "PointShopOrderItem"
      ADD CONSTRAINT "PointShopOrderItem_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "PointShopOrder"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopOrderItem_itemId_fkey'
  ) THEN
    ALTER TABLE "PointShopOrderItem"
      ADD CONSTRAINT "PointShopOrderItem_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "PointShopItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PointShopPointLedger" (
  "id" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "orderId" TEXT,
  "ledgerType" "PointShopPointLedgerType" NOT NULL,
  "deltaPoints" DECIMAL(19,4) NOT NULL,
  "balanceBefore" DECIMAL(19,4) NOT NULL,
  "balanceAfter" DECIMAL(19,4) NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointShopPointLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PointShopPointLedger_discordUserId_createdAt_idx"
  ON "PointShopPointLedger"("discordUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "PointShopPointLedger_orderId_idx"
  ON "PointShopPointLedger"("orderId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopPointLedger_discordUserId_fkey'
  ) THEN
    ALTER TABLE "PointShopPointLedger"
      ADD CONSTRAINT "PointShopPointLedger_discordUserId_fkey"
      FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopPointLedger_orderId_fkey'
  ) THEN
    ALTER TABLE "PointShopPointLedger"
      ADD CONSTRAINT "PointShopPointLedger_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "PointShopOrder"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
