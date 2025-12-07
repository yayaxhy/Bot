import { CouponType, LotteryStatus, OrderStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { round2 } from '../lib/money.js';
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
const LOTTERY_RATE = new Prisma.Decimal(0.2);
const LOTTERY_CAP = new Prisma.Decimal(200);
const MAX_BILLABLE_MINUTES = 120;
const FREE_MINUTES = 5;

function computeDiscountAmount(params: {
  unitPrice: Prisma.Decimal;
  totalMinutes: number;
  kind: DiscountKind;
}) {
  const { unitPrice, totalMinutes, kind } = params;
  if (totalMinutes <= FREE_MINUTES) return new Prisma.Decimal(0);

  const cappedMinutes = Math.min(totalMinutes, MAX_BILLABLE_MINUTES);
  const billableMinutes = cappedMinutes <= FREE_MINUTES ? 0 : cappedMinutes - FREE_MINUTES;
  if (billableMinutes <= 0) return new Prisma.Decimal(0);

  const perMinute = unitPrice.div(60);
  if (perMinute.lte(0)) return new Prisma.Decimal(0);

  const rate = kind === 'coupon' ? COUPON_RATE : LOTTERY_RATE;
  const cap = kind === 'coupon' ? COUPON_CAP : LOTTERY_CAP;

  let discount = round2(perMinute.mul(billableMinutes).mul(rate));
  if (discount.gt(cap)) discount = cap;
  return discount;
}

/**
 * Apply a discount for an ended order. Returns status codes for caller UI/API.
 */
export async function applyDiscountForOrder(params: {
  orderId: string;
  userId: string; // host id
  kind: DiscountKind;
  now?: Date;
}): Promise<ApplyDiscountResult> {
  const { orderId, userId, kind } = params;
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
        prize: { name: PRIZE_NAMES.DISCOUNT_80 },
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
    await tx.lotteryDraw.updateMany({
      where: {
        userId,
        status: LotteryStatus.UNUSED,
        expiresAt: { lte: now },
        prize: { name: PRIZE_NAMES.DISCOUNT_80 },
      },
      data: { status: LotteryStatus.EXPIRED },
    });

    let couponId: string | null = null;
    let lotteryId: string | null = null;

    if (kind === 'coupon') {
      const available = await tx.coupon.findFirst({
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
    } else {
      const voucher = await tx.lotteryDraw.findFirst({
        where: {
          userId,
          status: LotteryStatus.UNUSED,
          expiresAt: { gt: now },
          prize: { name: PRIZE_NAMES.DISCOUNT_80 },
        },
        select: { id: true },
        orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
      });
      if (!voucher) return { status: 'no_lottery' };
      lotteryId = voucher.id;
    }

    if (!order.unitPrice || order.totalMinutes == null) {
      return { status: 'insufficient_data' };
    }

    const unitPrice = new Prisma.Decimal(order.unitPrice);
    const discountAmount = computeDiscountAmount({
      unitPrice,
      totalMinutes: order.totalMinutes,
      kind,
    });
    if (discountAmount.lte(0)) return { status: 'no_fee' };

    await suppressRechargeNotifications(tx);
    const hostAccount = await tx.member.findUnique({
      where: { discordUserId: userId },
      select: { totalBalance: true },
    });
    const balanceBefore = new Prisma.Decimal(hostAccount?.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(discountAmount);

    if (kind === 'coupon' && couponId) {
      await tx.coupon.update({
        where: { id: couponId },
        data: {
          consumedAt: now,
          orderId: order.id,
          discountAmount,
          status: 'USED',
        },
      });
    }
    if (kind === 'lottery' && lotteryId) {
      await tx.lotteryDraw.update({
        where: { id: lotteryId },
        data: {
          status: LotteryStatus.USED,
          consumeAt: now,
          requestId: order.id,
        },
      });
    }

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
      kind,
      discountAmount,
      couponId: couponId ?? undefined,
      lotteryId: lotteryId ?? undefined,
    };
  });
}
