import { CouponStatus, CouponType, LotteryStatus, OrderStatus, PointShopDeliveryType, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import {
  applyJinleeWalletDeltaTx,
  ensureJinleeIdentityForDiscordTx,
  getJinleeWalletSnapshotTx,
  requireJinleeIdentityTx,
} from './jinleeAccountService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';
import { PRIZE_NAMES } from './lotteryService.js';

export type DiscountKind = 'coupon' | 'lottery';

export type ApplyDiscountResult =
  | {
      status: 'applied';
      kind: DiscountKind;
      consumeAmount: Prisma.Decimal;
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
const LEGACY_DISCOUNT_90_NAME = '特殊九折券';
const DISCOUNT_PRIZE_NAMES = [
  PRIZE_NAMES.DISCOUNT_80,
  PRIZE_NAMES.DISCOUNT_70,
  PRIZE_NAMES.DISCOUNT_90_LOTTERY,
  LEGACY_DISCOUNT_90_NAME,
];

type CouponSelectionCandidate = {
  id: string;
  source: 'coupon' | 'point_shop_coupon';
  expiresAt: Date;
  issuedAt: Date;
};

const pickEarliestExpiryCandidate = (
  candidates: Array<CouponSelectionCandidate | null>,
): CouponSelectionCandidate | null => {
  const available = candidates.filter((candidate): candidate is CouponSelectionCandidate => !!candidate);
  if (available.length === 0) return null;
  available.sort((left, right) => {
    const expireDelta = left.expiresAt.getTime() - right.expiresAt.getTime();
    if (expireDelta !== 0) return expireDelta;
    const issuedDelta = left.issuedAt.getTime() - right.issuedAt.getTime();
    if (issuedDelta !== 0) return issuedDelta;
    return left.id.localeCompare(right.id);
  });
  return available[0] ?? null;
};

const MAX_DISCOUNT_SELECTION_RETRIES = 10;

async function lockOrderForDiscountTx(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$executeRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
}

async function consumeCouponCandidateTx(
  tx: Prisma.TransactionClient,
  params: {
    candidate: CouponSelectionCandidate;
    jinleeId: string;
    orderId: string;
    discountAmount: Prisma.Decimal;
    workerDiscordUserId: string | null;
    workerJinleeId: string;
    now: Date;
  },
) {
  const { candidate, jinleeId, orderId, discountAmount, workerDiscordUserId, workerJinleeId, now } = params;

  if (candidate.source === 'point_shop_coupon') {
    const result = await tx.pointShopGrant.updateMany({
      where: {
        id: candidate.id,
        jinleeId,
        deliveryType: PointShopDeliveryType.COUPON,
        couponType: CouponType.DISCOUNT_90,
        couponStatus: CouponStatus.ACTIVE,
        expiresAt: { gt: now },
        consumedAt: null,
        consumeOrderId: null,
      },
      data: {
        consumedAt: now,
        consumeOrderId: orderId,
        consumeAmount: discountAmount,
        consumeTargetId: workerDiscordUserId,
        consumeTargetJinleeId: workerJinleeId,
        couponStatus: CouponStatus.USED,
      },
    });
    return result.count > 0;
  }

  const result = await tx.coupon.updateMany({
    where: {
      id: candidate.id,
      jinleeId,
      type: CouponType.DISCOUNT_90,
      status: CouponStatus.ACTIVE,
      expiresAt: { gt: now },
      consumedAt: null,
      orderId: null,
    },
    data: {
      consumedAt: now,
      orderId,
      consumeAmount: discountAmount,
      consumeTargetId: workerDiscordUserId,
      consumeTargetJinleeId: workerJinleeId,
      status: CouponStatus.USED,
    },
  });
  return result.count > 0;
}

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
  userId: string;
  couponId?: string;
  now?: Date;
}): Promise<ApplyDiscountResult> {
  const { orderId, userId, couponId: requestedCouponId } = params;
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const userIdentity = await requireJinleeIdentityTx(tx, userId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        hostId: true,
        hostJinleeId: true,
        workerId: true,
        status: true,
        unitPrice: true,
        totalMinutes: true,
      },
    });
    if (!order) return { status: 'order_not_found' };
    const orderHostJinleeId = order.hostJinleeId ?? null;
    if (orderHostJinleeId !== userIdentity.jinleeId && (!orderHostJinleeId || order.hostId !== userIdentity.discordUserId)) {
      return { status: 'not_order_host' };
    }
    if (order.status !== OrderStatus.ENDED) return { status: 'order_not_ended' };
    await lockOrderForDiscountTx(tx, order.id);
    const workerIdentity = await ensureJinleeIdentityForDiscordTx(tx, order.workerId);

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

    // prevent reuse
    const [existingCouponUsage, existingPointShopCouponUsage, existingLotteryUsage] = await Promise.all([
      tx.coupon.findFirst({
        where: { orderId, status: CouponStatus.USED },
        select: { id: true },
      }),
      tx.pointShopGrant.findFirst({
        where: {
          consumeOrderId: orderId,
          jinleeId: userIdentity.jinleeId,
          deliveryType: PointShopDeliveryType.COUPON,
          couponStatus: CouponStatus.USED,
        },
        select: { id: true },
      }),
      tx.lotteryDraw.findFirst({
        where: {
          jinleeId: userIdentity.jinleeId,
          status: LotteryStatus.USED,
          consumeOrderId: orderId,
          prize: { name: { in: DISCOUNT_PRIZE_NAMES } },
        },
        select: { id: true },
      }),
    ]);
    if (existingCouponUsage || existingPointShopCouponUsage || existingLotteryUsage) {
      return { status: 'already_used' };
    }

    // expire outdated vouchers
    await tx.coupon.updateMany({
      where: { jinleeId: userIdentity.jinleeId, status: CouponStatus.ACTIVE, expiresAt: { lte: now } },
      data: { status: CouponStatus.EXPIRED },
    });
    let selectedCouponId: string | null = null;
    let selectedCouponSource: 'coupon' | 'point_shop_coupon' | null = null;
    const findNextCouponCandidate = async (): Promise<CouponSelectionCandidate | null> => {
      const availableCoupon = requestedCouponId
        ? await tx.coupon.findFirst({
            where: {
              id: requestedCouponId,
              jinleeId: userIdentity.jinleeId,
              type: CouponType.DISCOUNT_90,
              status: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
            },
            select: { id: true, issuedAt: true, expiresAt: true },
          })
        : await tx.coupon.findFirst({
            where: {
              jinleeId: userIdentity.jinleeId,
              type: CouponType.DISCOUNT_90,
              status: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
            },
            orderBy: [{ expiresAt: 'asc' }, { issuedAt: 'asc' }],
            select: { id: true, issuedAt: true, expiresAt: true },
          });
      const availablePointShopCoupon = requestedCouponId
        ? await tx.pointShopGrant.findFirst({
            where: {
              id: requestedCouponId,
              jinleeId: userIdentity.jinleeId,
              deliveryType: PointShopDeliveryType.COUPON,
              couponStatus: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
              couponType: CouponType.DISCOUNT_90,
            },
            select: { id: true, issuedAt: true, expiresAt: true },
          })
        : await tx.pointShopGrant.findFirst({
            where: {
              jinleeId: userIdentity.jinleeId,
              deliveryType: PointShopDeliveryType.COUPON,
              couponStatus: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
              couponType: CouponType.DISCOUNT_90,
            },
            orderBy: [{ expiresAt: 'asc' }, { issuedAt: 'asc' }],
            select: { id: true, issuedAt: true, expiresAt: true },
          });

      return pickEarliestExpiryCandidate([
        availableCoupon
          ? {
              id: availableCoupon.id,
              source: 'coupon',
              expiresAt: availableCoupon.expiresAt,
              issuedAt: availableCoupon.issuedAt,
            }
          : null,
        availablePointShopCoupon?.expiresAt
          ? {
              id: availablePointShopCoupon.id,
              source: 'point_shop_coupon',
              expiresAt: availablePointShopCoupon.expiresAt,
              issuedAt: availablePointShopCoupon.issuedAt,
            }
          : null,
      ]);
    };

    for (let attempt = 0; attempt < MAX_DISCOUNT_SELECTION_RETRIES; attempt++) {
      const candidate = await findNextCouponCandidate();
      if (!candidate) break;

      const consumed = await consumeCouponCandidateTx(tx, {
        candidate,
        jinleeId: userIdentity.jinleeId,
        orderId: order.id,
        discountAmount,
        workerDiscordUserId: workerIdentity.discordUserId ?? order.workerId ?? null,
        workerJinleeId: workerIdentity.jinleeId,
        now,
      });

      if (consumed) {
        selectedCouponId = candidate.id;
        selectedCouponSource = candidate.source;
        break;
      }

      if (requestedCouponId) {
        break;
      }
    }

    if (!selectedCouponId || !selectedCouponSource) return { status: 'no_coupon' };

    await suppressRechargeNotifications(tx);
    const walletSnapshot = await getJinleeWalletSnapshotTx(tx, userIdentity);
    const balanceBefore = walletSnapshot.totalBalance;
    const balanceAfter = balanceBefore.add(discountAmount);

    await applyJinleeWalletDeltaTx(tx, {
      jinleeId: userIdentity.jinleeId,
      discordUserId: userIdentity.discordUserId,
      rechargeDelta: discountAmount,
      totalBalanceDelta: discountAmount,
    });

    await recordIndividualTransaction(tx, {
      discordId: userIdentity.discordUserId,
      jinleeId: userIdentity.jinleeId,
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
      couponId: selectedCouponId ?? undefined,
    };
  });
}
