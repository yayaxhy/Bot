import { LotteryStatus, OrderStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';
import type { ApplyDiscountResult } from './discountService.js';
import { PRIZE_NAMES } from './lotteryService.js';

const DISCOUNT_PRIZE_CONFIG: Record<string, { rate: Prisma.Decimal; cap: Prisma.Decimal }> = {
  [PRIZE_NAMES.DISCOUNT_80]: { rate: new Prisma.Decimal(0.2), cap: new Prisma.Decimal(100) },
  [PRIZE_NAMES.DISCOUNT_70]: { rate: new Prisma.Decimal(0.3), cap: new Prisma.Decimal(150) },
  [PRIZE_NAMES.DISCOUNT_90_LOTTERY]: { rate: new Prisma.Decimal(0.1), cap: new Prisma.Decimal(50) },
};
const FREE_MINUTES = 5;

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
  const { orderId, userId, lotteryId, prizeName } = params;
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
        prize: { name: { in: Object.keys(DISCOUNT_PRIZE_CONFIG) } },
      },
      data: { status: LotteryStatus.EXPIRED },
    });

    const prizeFilter = prizeName ? { name: prizeName } : { name: { in: Object.keys(DISCOUNT_PRIZE_CONFIG) } };

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

    const prizeName = voucher.prize?.name ?? '';
    const config = DISCOUNT_PRIZE_CONFIG[prizeName];
    if (!config) return { status: 'no_lottery' };

    if (!order.unitPrice || order.totalMinutes == null) {
      return { status: 'insufficient_data' };
    }

    const unitPrice = new Prisma.Decimal(order.unitPrice);
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
      discountAmount,
      lotteryId: voucher.id,
    };
  });
}
