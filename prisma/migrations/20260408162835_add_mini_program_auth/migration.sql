-- CreateEnum
CREATE TYPE "AccountProvider" AS ENUM ('DISCORD', 'WECHAT_MINIPROGRAM');

-- CreateTable
CREATE TABLE "JinleeUser" (
    "jinleeId" TEXT NOT NULL,
    "discordUserId" TEXT,
    "discordDisplayName" TEXT,
    "discordAvatarUrl" TEXT,
    "wechatDisplayName" TEXT,
    "wechatAvatarUrl" TEXT,
    "totalBalance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "income" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "recharge" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalSpent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "loyaltyPoints" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "withdrawAccount1" TEXT,
    "withdrawAccount2" TEXT,
    "withdrawAccount3" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JinleeUser_pkey" PRIMARY KEY ("jinleeId")
);

-- CreateTable
CREATE TABLE "AccountBinding" (
    "id" TEXT NOT NULL,
    "jinleeId" TEXT NOT NULL,
    "provider" "AccountProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "unionId" TEXT,
    "profile" JSONB,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WechatProgramSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "jinleeId" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "WechatProgramSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JinleeUser_discordUserId_key" ON "JinleeUser"("discordUserId");

-- CreateIndex
CREATE INDEX "AccountBinding_jinleeId_idx" ON "AccountBinding"("jinleeId");

-- CreateIndex
CREATE INDEX "AccountBinding_provider_unionId_idx" ON "AccountBinding"("provider", "unionId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountBinding_provider_providerUserId_key" ON "AccountBinding"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WechatProgramSession_tokenHash_key" ON "WechatProgramSession"("tokenHash");

-- CreateIndex
CREATE INDEX "WechatProgramSession_jinleeId_expiresAt_idx" ON "WechatProgramSession"("jinleeId", "expiresAt");

-- AddForeignKey
ALTER TABLE "JinleeUser" ADD CONSTRAINT "JinleeUser_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBinding" ADD CONSTRAINT "AccountBinding_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WechatProgramSession" ADD CONSTRAINT "WechatProgramSession_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WechatProgramSession" ADD CONSTRAINT "WechatProgramSession_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "AccountBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Helpers to generate cuid-style Jinlee ids for backfilled legacy rows.
CREATE OR REPLACE FUNCTION "__jinlee_to_base36"(input_num bigint)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    chars constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
    num bigint := GREATEST(input_num, 0);
    result text := '';
BEGIN
    IF num = 0 THEN
        RETURN '0';
    END IF;

    WHILE num > 0 LOOP
        result := substr(chars, (num % 36) + 1, 1) || result;
        num := num / 36;
    END LOOP;

    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION "__generate_jinlee_cuid"(seq_no bigint)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    ts_part text := lpad("__jinlee_to_base36"(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 8, '0');
    counter_part text := right(lpad("__jinlee_to_base36"(seq_no), 4, '0'), 4);
    fingerprint_part text := right(lpad("__jinlee_to_base36"(abs(hashtext(pg_backend_pid()::text))::bigint), 4, '0'), 4);
    random_part_1 text := right(lpad("__jinlee_to_base36"(abs(hashtext(gen_random_uuid()::text))::bigint), 4, '0'), 4);
    random_part_2 text := right(lpad("__jinlee_to_base36"(abs(hashtext(gen_random_uuid()::text || seq_no::text))::bigint), 4, '0'), 4);
BEGIN
    RETURN 'ju' || 'c' || ts_part || counter_part || fingerprint_part || random_part_1 || random_part_2;
END;
$$;

-- Seed JinleeUser rows for existing Discord members so ownership backfills are deterministic.
INSERT INTO "JinleeUser" (
    "jinleeId",
    "discordUserId",
    "discordDisplayName",
    "totalBalance",
    "income",
    "recharge",
    "totalSpent",
    "createdAt",
    "updatedAt"
)
SELECT
    "__generate_jinlee_cuid"(ROW_NUMBER() OVER (ORDER BY m."discordUserId")),
    m."discordUserId",
    m."serverDisplayName",
    m."totalBalance",
    m."income",
    m."recharge",
    m."totalSpent",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Member" m;

-- Seed Discord bindings for the backfilled Jinlee users.
INSERT INTO "AccountBinding" (
    "id",
    "jinleeId",
    "provider",
    "providerUserId",
    "lastLoginAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'ab_' || replace(gen_random_uuid()::text, '-', ''),
    ju."jinleeId",
    'DISCORD'::"AccountProvider",
    ju."discordUserId",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "JinleeUser" ju
WHERE ju."discordUserId" IS NOT NULL;

-- Extend legacy consumer-owned tables with Jinlee ownership.
ALTER TABLE "LoyaltyPoint" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "fromJinleeId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "toJinleeId" TEXT;
ALTER TABLE "order_audit" ADD COLUMN "hostJinleeId" TEXT;
ALTER TABLE "order_audit" ADD COLUMN "hostWechatOpenId" TEXT;
ALTER TABLE "order_audit" ADD COLUMN "workerJinleeId" TEXT;
ALTER TABLE "Recharge" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "Withdraw" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "IndividualTransaction" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "WithdrawalAccount" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "Coupon" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "Coupon" ADD COLUMN "consumeTargetJinleeId" TEXT;
ALTER TABLE "Commission" ADD COLUMN "fromJinleeId" TEXT;
ALTER TABLE "Commission" ADD COLUMN "toJinleeId" TEXT;
ALTER TABLE "ZPayRechargeOrder" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "Order" ADD COLUMN "hostJinleeId" TEXT;
ALTER TABLE "LotteryDraw" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "LotteryDraw" ADD COLUMN "consumeTargetJinleeId" TEXT;
ALTER TABLE "LotteryPity" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "PointShopCart" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "PointShopOrder" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "PointShopGrant" ADD COLUMN "jinleeId" TEXT;
ALTER TABLE "PointShopGrant" ADD COLUMN "consumeTargetJinleeId" TEXT;
ALTER TABLE "PointShopPointLedger" ADD COLUMN "jinleeId" TEXT;

ALTER TABLE "Transaction" ALTER COLUMN "fromId" DROP NOT NULL;
ALTER TABLE "Commission" ALTER COLUMN "fromId" DROP NOT NULL;
ALTER TABLE "order_audit" ALTER COLUMN "hostId" DROP NOT NULL;
ALTER TABLE "Withdraw" ALTER COLUMN "discordId" DROP NOT NULL;
ALTER TABLE "IndividualTransaction" ALTER COLUMN "discordId" DROP NOT NULL;
ALTER TABLE "Coupon" ALTER COLUMN "discordId" DROP NOT NULL;
ALTER TABLE "Recharge" ALTER COLUMN "toWhom" DROP NOT NULL;
ALTER TABLE "ZPayRechargeOrder" ALTER COLUMN "discordUserId" DROP NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "hostId" DROP NOT NULL;
ALTER TABLE "LotteryDraw" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "PointShopCart" ALTER COLUMN "discordUserId" DROP NOT NULL;
ALTER TABLE "PointShopOrder" ALTER COLUMN "discordUserId" DROP NOT NULL;
ALTER TABLE "PointShopGrant" ALTER COLUMN "discordUserId" DROP NOT NULL;
ALTER TABLE "PointShopPointLedger" ALTER COLUMN "discordUserId" DROP NOT NULL;

-- Backfill Jinlee ownership from existing Discord-linked users.
UPDATE "LoyaltyPoint" lp
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE lp."discordUserId" = ju."discordUserId";

UPDATE "Transaction" t
SET
    "fromJinleeId" = (
        SELECT ju."jinleeId"
        FROM "JinleeUser" ju
        WHERE ju."discordUserId" = t."fromId"
    ),
    "toJinleeId" = (
        SELECT ju."jinleeId"
        FROM "JinleeUser" ju
        WHERE ju."discordUserId" = t."toId"
    );

UPDATE "Recharge" r
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE r."toWhom" = ju."discordUserId";

UPDATE "Withdraw" w
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE w."discordId" = ju."discordUserId";

UPDATE "IndividualTransaction" it
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE it."discordId" = ju."discordUserId";

UPDATE "WithdrawalAccount" wa
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE wa."discordUserId" = ju."discordUserId";

UPDATE "JinleeUser" ju
SET "loyaltyPoints" = lp."points"
FROM "LoyaltyPoint" lp
WHERE ju."discordUserId" = lp."discordUserId";

UPDATE "JinleeUser" ju
SET
    "withdrawAccount1" = wa."account1",
    "withdrawAccount2" = wa."account2",
    "withdrawAccount3" = wa."account3"
FROM "WithdrawalAccount" wa
WHERE ju."discordUserId" = wa."discordUserId";

UPDATE "Coupon" c
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE c."discordId" = ju."discordUserId";

UPDATE "Coupon" c
SET "consumeTargetJinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE c."consumeTargetId" = ju."discordUserId";

UPDATE "Commission" c
SET
    "fromJinleeId" = (
        SELECT ju."jinleeId"
        FROM "JinleeUser" ju
        WHERE ju."discordUserId" = c."fromId"
    ),
    "toJinleeId" = (
        SELECT ju."jinleeId"
        FROM "JinleeUser" ju
        WHERE ju."discordUserId" = c."toId"
    );

UPDATE "ZPayRechargeOrder" z
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE z."discordUserId" = ju."discordUserId";

UPDATE "Order" o
SET "hostJinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE o."hostId" = ju."discordUserId";

UPDATE "order_audit" oa
SET
    "hostJinleeId" = COALESCE(
        (
            SELECT o."hostJinleeId"
            FROM "Order" o
            WHERE o."id" = oa."orderId"
        ),
        (
            SELECT ju."jinleeId"
            FROM "JinleeUser" ju
            WHERE ju."discordUserId" = oa."hostId"
        )
    ),
    "workerJinleeId" = (
        SELECT ju."jinleeId"
        FROM "JinleeUser" ju
        WHERE ju."discordUserId" = oa."workerId"
    );

UPDATE "LotteryDraw" ld
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE ld."userId" = ju."discordUserId";

UPDATE "LotteryDraw" ld
SET "consumeTargetJinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE ld."consumeTargetId" = ju."discordUserId";

UPDATE "LotteryPity" lp
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE lp."userId" = ju."discordUserId";

UPDATE "order_audit" oa
SET "hostWechatOpenId" = ab."providerUserId"
FROM "AccountBinding" ab
WHERE oa."hostJinleeId" = ab."jinleeId"
  AND ab."provider" = 'WECHAT_MINIPROGRAM'::"AccountProvider"
  AND oa."hostWechatOpenId" IS NULL;

ALTER TABLE "order_audit" ALTER COLUMN "hostJinleeId" SET NOT NULL;
ALTER TABLE "order_audit" ALTER COLUMN "workerJinleeId" SET NOT NULL;

ALTER TABLE "LotteryPity" DROP CONSTRAINT "LotteryPity_pkey";
ALTER TABLE "LotteryPity" DROP CONSTRAINT "LotteryPity_userId_fkey";
ALTER TABLE "LotteryPity" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "LotteryPity" ALTER COLUMN "jinleeId" SET NOT NULL;
ALTER TABLE "LotteryPity" ADD CONSTRAINT "LotteryPity_pkey" PRIMARY KEY ("jinleeId");

UPDATE "PointShopCart" cart
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE cart."discordUserId" = ju."discordUserId";

UPDATE "PointShopOrder" ord
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE ord."discordUserId" = ju."discordUserId";

UPDATE "PointShopGrant" grant_row
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE grant_row."discordUserId" = ju."discordUserId";

UPDATE "PointShopGrant" grant_row
SET "consumeTargetJinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE grant_row."consumeTargetId" = ju."discordUserId";

UPDATE "PointShopPointLedger" ledger
SET "jinleeId" = ju."jinleeId"
FROM "JinleeUser" ju
WHERE ledger."discordUserId" = ju."discordUserId";

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyPoint_jinleeId_key" ON "LoyaltyPoint"("jinleeId");
CREATE INDEX "Transaction_fromJinleeId_createdAt_idx" ON "Transaction"("fromJinleeId", "createdAt");
CREATE INDEX "Transaction_toJinleeId_createdAt_idx" ON "Transaction"("toJinleeId", "createdAt");
CREATE INDEX "Recharge_jinleeId_createdAt_idx" ON "Recharge"("jinleeId", "createdAt");
CREATE INDEX "Withdraw_jinleeId_createdAt_idx" ON "Withdraw"("jinleeId", "createdAt");
CREATE INDEX "IndividualTransaction_jinleeId_idx" ON "IndividualTransaction"("jinleeId");
CREATE INDEX "IndividualTransaction_jinleeId_timeCreatedAt_typeOfTransaction_idx" ON "IndividualTransaction"("jinleeId", "timeCreatedAt", "typeOfTransaction");
CREATE UNIQUE INDEX "WithdrawalAccount_jinleeId_key" ON "WithdrawalAccount"("jinleeId");
CREATE INDEX "Coupon_jinleeId_status_expiresAt_idx" ON "Coupon"("jinleeId", "status", "expiresAt");
CREATE INDEX "Coupon_consumeTargetJinleeId_idx" ON "Coupon"("consumeTargetJinleeId");
CREATE INDEX "Commission_fromJinleeId_idx" ON "Commission"("fromJinleeId");
CREATE INDEX "Commission_toJinleeId_idx" ON "Commission"("toJinleeId");
CREATE INDEX "ZPayRechargeOrder_jinleeId_status_createdAt_idx" ON "ZPayRechargeOrder"("jinleeId", "status", "createdAt");
CREATE INDEX "Order_hostJinleeId_status_idx" ON "Order"("hostJinleeId", "status");
CREATE INDEX "order_audit_hostJinleeId_createdAt_idx" ON "order_audit"("hostJinleeId", "createdAt");
CREATE INDEX "order_audit_workerJinleeId_createdAt_idx" ON "order_audit"("workerJinleeId", "createdAt");
CREATE INDEX "order_audit_hostId_createdAt_idx" ON "order_audit"("hostId", "createdAt");
CREATE INDEX "LotteryDraw_jinleeId_createdAt_idx" ON "LotteryDraw"("jinleeId", "createdAt");
CREATE INDEX "LotteryDraw_consumeTargetJinleeId_idx" ON "LotteryDraw"("consumeTargetJinleeId");
CREATE UNIQUE INDEX "LotteryPity_userId_key" ON "LotteryPity"("userId");
CREATE INDEX "PointShopCart_jinleeId_status_updatedAt_idx" ON "PointShopCart"("jinleeId", "status", "updatedAt");
CREATE UNIQUE INDEX "PointShopCart_open_jinleeId_key" ON "PointShopCart"("jinleeId") WHERE "status" = 'OPEN' AND "jinleeId" IS NOT NULL;
CREATE UNIQUE INDEX "PointShopOrder_jinleeId_requestKey_key" ON "PointShopOrder"("jinleeId", "requestKey");
CREATE INDEX "PointShopOrder_jinleeId_createdAt_idx" ON "PointShopOrder"("jinleeId", "createdAt");
CREATE INDEX "PointShopGrant_jinleeId_couponStatus_expiresAt_idx" ON "PointShopGrant"("jinleeId", "status", "expiresAt");
CREATE INDEX "PointShopGrant_jinleeId_deliveryType_deliveryStatus_createdAt_idx" ON "PointShopGrant"("jinleeId", "deliveryType", "deliveryStatus", "createdAt");
CREATE INDEX "PointShopGrant_consumeTargetJinleeId_idx" ON "PointShopGrant"("consumeTargetJinleeId");
CREATE INDEX "PointShopPointLedger_jinleeId_createdAt_idx" ON "PointShopPointLedger"("jinleeId", "createdAt");

-- AddForeignKey
ALTER TABLE "LoyaltyPoint" ADD CONSTRAINT "LoyaltyPoint_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fromJinleeId_fkey" FOREIGN KEY ("fromJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_toJinleeId_fkey" FOREIGN KEY ("toJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Recharge" ADD CONSTRAINT "Recharge_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Withdraw" ADD CONSTRAINT "Withdraw_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IndividualTransaction" ADD CONSTRAINT "IndividualTransaction_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalAccount" ADD CONSTRAINT "WithdrawalAccount_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_consumeTargetJinleeId_fkey" FOREIGN KEY ("consumeTargetJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_fromJinleeId_fkey" FOREIGN KEY ("fromJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_toJinleeId_fkey" FOREIGN KEY ("toJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ZPayRechargeOrder" ADD CONSTRAINT "ZPayRechargeOrder_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_hostJinleeId_fkey" FOREIGN KEY ("hostJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LotteryDraw" ADD CONSTRAINT "LotteryDraw_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LotteryDraw" ADD CONSTRAINT "LotteryDraw_consumeTargetJinleeId_fkey" FOREIGN KEY ("consumeTargetJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LotteryPity" ADD CONSTRAINT "LotteryPity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("discordUserId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LotteryPity" ADD CONSTRAINT "LotteryPity_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PointShopCart" ADD CONSTRAINT "PointShopCart_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PointShopOrder" ADD CONSTRAINT "PointShopOrder_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PointShopGrant" ADD CONSTRAINT "PointShopGrant_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PointShopGrant" ADD CONSTRAINT "PointShopGrant_consumeTargetJinleeId_fkey" FOREIGN KEY ("consumeTargetJinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PointShopPointLedger" ADD CONSTRAINT "PointShopPointLedger_jinleeId_fkey" FOREIGN KEY ("jinleeId") REFERENCES "JinleeUser"("jinleeId") ON DELETE SET NULL ON UPDATE CASCADE;

DROP FUNCTION "__generate_jinlee_cuid"(bigint);
DROP FUNCTION "__jinlee_to_base36"(bigint);
