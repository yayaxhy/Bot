import { CouponStatus, CouponType, LotteryStatus, OrderStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';
import type { ApplyDiscountResult } from './discountService.js';
import { PRIZE_NAMES } from './lotteryService.js';

const LEGACY_DISCOUNT_90_NAME = '特殊九折券';
const DISCOUNT_PRIZE_CONFIG: Record<string, { rate: Prisma.Decimal; cap: Prisma.Decimal }> = {
  [PRIZE_NAMES.DISCOUNT_80]: { rate: new Prisma.Decimal(0.2), cap: new Prisma.Decimal(100) },
  [PRIZE_NAMES.DISCOUNT_70]: { rate: new Prisma.Decimal(0.3), cap: new Prisma.Decimal(150) },
  [PRIZE_NAMES.DISCOUNT_90_LOTTERY]: { rate: new Prisma.Decimal(0.1), cap: new Prisma.Decimal(50) },
  // Legacy name compatibility
  [LEGACY_DISCOUNT_90_NAME]: { rate: new Prisma.Decimal(0.1), cap: new Prisma.Decimal(50) },
};
const DISCOUNT_PRIZE_NAMES = Object.keys(DISCOUNT_PRIZE_CONFIG);
const FREE_MINUTES = 5;
const DISCOUNT_COUPON_TYPE_MAP: Record<string, CouponType> = {
  [PRIZE_NAMES.DISCOUNT_80]: CouponType.DISCOUNT_80,
  [PRIZE_NAMES.DISCOUNT_70]: CouponType.DISCOUNT_70,
  [PRIZE_NAMES.DISCOUNT_90_LOTTERY]: CouponType.DISCOUNT_90_LOTTERY,
  [LEGACY_DISCOUNT_90_NAME]: CouponType.DISCOUNT_90_LOTTERY,
};

function computeDiscountAmount(params: {
  unitPrice: Prisma.Decimal;
  totalMinutes: number;
  rate: Prisma.Decimal;
  cap: Prisma.Decimal;
}): Prisma.Decimal {
  const { unitPrice, totalMinutes, rate, cap } = params;
  if (totalMinutes <= FREE_MINUTES) return new Prisma.Decimal(0);

  const billableMinutes = totalMinutes - FREE_MINUTES;
  if (billableMinutes <= 0) return new Prisma.Decimal(0);

  const perMinute = unitPrice.div(60);
  if (perMinute.lte(0)) return new Prisma.Decimal(0);

  let discount = new Prisma.Decimal(perMinute.mul(billableMinutes).mul(rate).toFixed(2, Prisma.Decimal.ROUND_HALF_UP));
  if (discount.gt(cap)) discount = cap;
  return discount;
}

/**
 * Apply a lottery 8 折券 for an ended order. Separated from 9 折券逻辑。
 */
export async function applyLotteryDiscountForOrder(params: {
  orderId: string;
  userId: string; // host id
  lotteryId?: string;
  prizeName?: string;
  now?: Date;
}): Promise<ApplyDiscountResult> {
  const { orderId, userId, lotteryId, prizeName: requestedPrizeName } = params;
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        hostId: true,
        workerId: true,
        status: true,
        unitPrice: true,
        totalMinutes: true,
      },
    });
    if (!order) return { status: 'order_not_found' };
    if (order.hostId !== userId) return { status: 'not_order_host' };
    if (order.status !== OrderStatus.ENDED) return { status: 'order_not_ended' };

    // prevent reuse
    const existingCouponUsage = await tx.coupon.findFirst({
      where: { orderId, status: 'USED' },
      select: { id: true },
    });
    const existingLotteryUsage = await tx.lotteryDraw.findFirst({
      where: {
        userId,
        status: LotteryStatus.USED,
        requestId: orderId,
        prize: { name: { in: Object.keys(DISCOUNT_PRIZE_CONFIG) } },
      },
      select: { id: true },
    });
    if (existingCouponUsage || existingLotteryUsage) {
      return { status: 'already_used' };
    }

    // expire outdated 8 折券
    await tx.lotteryDraw.updateMany({
      where: {
        userId,
        status: LotteryStatus.UNUSED,
        expiresAt: { lte: now },
        prize: { name: { in: DISCOUNT_PRIZE_NAMES } },
      },
      data: { status: LotteryStatus.EXPIRED },
    });

    const namesFilter = requestedPrizeName
      ? [
          requestedPrizeName,
          ...(requestedPrizeName === PRIZE_NAMES.DISCOUNT_90_LOTTERY ? [LEGACY_DISCOUNT_90_NAME] : []),
        ]
      : DISCOUNT_PRIZE_NAMES;
    const prizeFilter: { name: { in: string[] } } = { name: { in: namesFilter } };

    const couponTypes = requestedPrizeName
      ? Array.from(
          new Set(
            [
              DISCOUNT_COUPON_TYPE_MAP[requestedPrizeName],
              ...(requestedPrizeName === PRIZE_NAMES.DISCOUNT_90_LOTTERY
                ? [DISCOUNT_COUPON_TYPE_MAP[LEGACY_DISCOUNT_90_NAME]]
                : []),
            ].filter(Boolean)
          )
        )
      : Array.from(new Set(Object.values(DISCOUNT_COUPON_TYPE_MAP)));

    // expire outdated coupons
    if (couponTypes.length > 0) {
      await tx.coupon.updateMany({
        where: { discordId: userId, status: CouponStatus.ACTIVE, expiresAt: { lte: now }, type: { in: couponTypes } },
        data: { status: CouponStatus.EXPIRED },
      });
    }

    const availableCoupon = couponTypes.length
      ? await tx.coupon.findFirst({
          where: {
            discordId: userId,
            type: { in: couponTypes },
            status: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
          },
          orderBy: { issuedAt: 'asc' },
        })
      : null;

    if (!order.unitPrice || order.totalMinutes == null) {
      return { status: 'insufficient_data' };
    }

    const unitPrice = new Prisma.Decimal(order.unitPrice);

    if (availableCoupon) {
      const couponType = availableCoupon.type;
      const prizeNameUsed = Object.entries(DISCOUNT_COUPON_TYPE_MAP).find(
        ([, type]) => type === couponType
      )?.[0] ?? '';
      const config = DISCOUNT_PRIZE_CONFIG[prizeNameUsed];
      if (!config) return { status: 'no_lottery' };

      const discountAmount = computeDiscountAmount({
        unitPrice,
        totalMinutes: order.totalMinutes,
        rate: config.rate,
        cap: config.cap,
      });
      if (discountAmount.lte(0)) return { status: 'no_fee' };

      await suppressRechargeNotifications(tx);
      const hostAccount = await tx.member.findUnique({
        where: { discordUserId: userId },
        select: { totalBalance: true },
      });
      const balanceBefore = new Prisma.Decimal(hostAccount?.totalBalance ?? 0);
      const balanceAfter = balanceBefore.add(discountAmount);

      await tx.coupon.update({
        where: { id: availableCoupon.id },
        data: {
          consumedAt: now,
          orderId: order.id,
          consumeAmount: discountAmount,
          consumeTargetId: order.workerId ?? null,
          status: CouponStatus.USED,
        },
      });

      await tx.member.update({
        where: { discordUserId: userId },
        data: {
          recharge: { increment: discountAmount },
          totalBalance: { increment: discountAmount },
        },
      });

      await recordIndividualTransaction(tx, {
        discordId: userId,
        thirdPartydiscordId: order.workerId ?? 'SYSTEM',
        balanceBefore,
        amountChange: discountAmount,
        balanceAfter,
        typeOfTransaction: '优惠返利',
        timeCreatedAt: now,
      });

      return {
        status: 'applied',
        kind: 'coupon',
        consumeAmount: discountAmount,
        couponId: availableCoupon.id,
      };
    }

    const voucher = lotteryId
      ? await tx.lotteryDraw.findFirst({
          where: {
            id: lotteryId,
            userId,
            status: LotteryStatus.UNUSED,
            expiresAt: { gt: now },
            prize: prizeFilter,
          },
          select: { id: true, prize: { select: { name: true } } },
        })
      : await tx.lotteryDraw.findFirst({
          where: {
            userId,
            status: LotteryStatus.UNUSED,
            expiresAt: { gt: now },
            prize: prizeFilter,
          },
          select: { id: true, prize: { select: { name: true } } },
          orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
        });
    if (!voucher) return { status: 'no_lottery' };

    const prizeNameUsed = voucher.prize?.name ?? '';
    const config = DISCOUNT_PRIZE_CONFIG[prizeNameUsed];
    if (!config) return { status: 'no_lottery' };
    const discountAmount = computeDiscountAmount({
      unitPrice,
      totalMinutes: order.totalMinutes,
      rate: config.rate,
      cap: config.cap,
    });
    if (discountAmount.lte(0)) return { status: 'no_fee' };

    await suppressRechargeNotifications(tx);
    const hostAccount = await tx.member.findUnique({
      where: { discordUserId: userId },
      select: { totalBalance: true },
    });
    const balanceBefore = new Prisma.Decimal(hostAccount?.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(discountAmount);

    await tx.lotteryDraw.update({
      where: { id: voucher.id },
      data: {
        status: LotteryStatus.USED,
        consumeAt: now,
        requestId: order.id,
        consumeAmount: discountAmount,
        consumeOrderId: order.id,
        consumeTargetId: order.workerId ?? null,
      },
    });

    await tx.member.update({
      where: { discordUserId: userId },
      data: {
        recharge: { increment: discountAmount },
        totalBalance: { increment: discountAmount },
      },
    });

    await recordIndividualTransaction(tx, {
      discordId: userId,
      thirdPartydiscordId: order.workerId ?? 'SYSTEM',
      balanceBefore,
      amountChange: discountAmount,
      balanceAfter,
      typeOfTransaction: '优惠返利',
      timeCreatedAt: now,
    });

    return {
      status: 'applied',
      kind: 'lottery',
      consumeAmount: discountAmount,
      lotteryId: voucher.id,
    };
  });
}
