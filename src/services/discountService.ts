import { CouponType, LotteryStatus, OrderStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';
import { PRIZE_NAMES } from './lotteryService.js';

export type DiscountKind = 'coupon' | 'lottery';

export type ApplyDiscountResult =
  | {
      status: 'applied';
      kind: DiscountKind;
      discountAmount: Prisma.Decimal;
      couponId?: string;
      lotteryId?: string;
    }
  | { status: 'order_not_found' }
  | { status: 'not_order_host' }
  | { status: 'order_not_ended' }
  | { status: 'already_used' }
  | { status: 'no_coupon' }
  | { status: 'no_lottery' }
  | { status: 'no_fee' }
  | { status: 'insufficient_data' };

const COUPON_RATE = new Prisma.Decimal(0.1);
const COUPON_CAP = new Prisma.Decimal(20);
const MAX_BILLABLE_MINUTES = 120;
const FREE_MINUTES = 5;

function computeDiscountAmount(params: {
  unitPrice: Prisma.Decimal;
  totalMinutes: number;
  rate: Prisma.Decimal;
  cap: Prisma.Decimal;
}): Prisma.Decimal {
  const { unitPrice, totalMinutes, rate, cap } = params;
  if (totalMinutes <= FREE_MINUTES) return new Prisma.Decimal(0);

  const cappedMinutes = Math.min(totalMinutes, MAX_BILLABLE_MINUTES);
  const billableMinutes = cappedMinutes <= FREE_MINUTES ? 0 : cappedMinutes - FREE_MINUTES;
  if (billableMinutes <= 0) return new Prisma.Decimal(0);

  const perMinute = unitPrice.div(60);
  if (perMinute.lte(0)) return new Prisma.Decimal(0);

  let discount = new Prisma.Decimal(perMinute.mul(billableMinutes).mul(rate).toFixed(2, Prisma.Decimal.ROUND_HALF_UP));
  if (discount.gt(cap)) discount = cap;
  return discount;
}

/**
 * Apply a discount for an ended order. Returns status codes for caller UI/API.
 */
export async function applyCouponDiscountForOrder(params: {
  orderId: string;
  userId: string; // host id
  couponId?: string;
  now?: Date;
}): Promise<ApplyDiscountResult> {
  const { orderId, userId, couponId } = params;
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
        prize: { name: { in: [PRIZE_NAMES.DISCOUNT_80, PRIZE_NAMES.DISCOUNT_70, PRIZE_NAMES.DISCOUNT_90_LOTTERY] } },
      },
      select: { id: true },
    });
    if (existingCouponUsage || existingLotteryUsage) {
      return { status: 'already_used' };
    }

    // expire outdated vouchers
    await tx.coupon.updateMany({
      where: { discordId: userId, status: 'ACTIVE', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    let couponId: string | null = null;

    const available = couponId
      ? await tx.coupon.findFirst({
          where: {
            id: couponId,
            discordId: userId,
            type: CouponType.DISCOUNT_90,
            status: 'ACTIVE',
            expiresAt: { gt: now },
          },
        })
      : await tx.coupon.findFirst({
          where: {
            discordId: userId,
            type: CouponType.DISCOUNT_90,
            status: 'ACTIVE',
            expiresAt: { gt: now },
          },
          orderBy: { issuedAt: 'asc' },
        });
    if (!available) return { status: 'no_coupon' };
    couponId = available.id;

    if (!order.unitPrice || order.totalMinutes == null) {
      return { status: 'insufficient_data' };
    }

    const unitPrice = new Prisma.Decimal(order.unitPrice);
    const discountAmount = computeDiscountAmount({
      unitPrice,
      totalMinutes: order.totalMinutes,
      rate: COUPON_RATE,
      cap: COUPON_CAP,
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
      where: { id: couponId },
      data: {
        consumedAt: now,
        orderId: order.id,
        discountAmount,
        status: 'USED',
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
      discountAmount,
      couponId: couponId ?? undefined,
    };
  });
}
