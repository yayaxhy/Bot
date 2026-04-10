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

type DiscountSelectionCandidate =
  | {
      id: string;
      source: 'coupon';
      expiresAt: Date;
      issuedAt: Date;
      couponType: CouponType;
    }
  | {
      id: string;
      source: 'point_shop_coupon';
      expiresAt: Date;
      issuedAt: Date;
      couponType: CouponType;
    }
  | {
      id: string;
      source: 'lottery';
      expiresAt: Date;
      issuedAt: Date;
      prizeName: string;
    };

const pickEarliestExpiryDiscountCandidate = (
  candidates: Array<DiscountSelectionCandidate | null>,
): DiscountSelectionCandidate | null => {
  const available = candidates.filter((candidate): candidate is DiscountSelectionCandidate => !!candidate);
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

async function consumeDiscountCandidateTx(
  tx: Prisma.TransactionClient,
  params: {
    candidate: DiscountSelectionCandidate;
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
        couponType: candidate.couponType,
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

  if (candidate.source === 'coupon') {
    const result = await tx.coupon.updateMany({
      where: {
        id: candidate.id,
        jinleeId,
        type: candidate.couponType,
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

  const result = await tx.lotteryDraw.updateMany({
    where: {
      id: candidate.id,
      jinleeId,
      status: LotteryStatus.UNUSED,
      expiresAt: { gt: now },
      consumeAt: null,
      consumeOrderId: null,
      requestId: null,
      prize: { name: candidate.prizeName },
    },
    data: {
      status: LotteryStatus.USED,
      consumeAt: now,
      requestId: orderId,
      consumeAmount: discountAmount,
      consumeOrderId: orderId,
      consumeTargetId: workerDiscordUserId,
      consumeTargetJinleeId: workerJinleeId,
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
  userId: string;
  lotteryId?: string;
  prizeName?: string;
  now?: Date;
}): Promise<ApplyDiscountResult> {
  const { orderId, userId, lotteryId, prizeName: requestedPrizeName } = params;
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
          requestId: orderId,
          prize: { name: { in: Object.keys(DISCOUNT_PRIZE_CONFIG) } },
        },
        select: { id: true },
      }),
    ]);
    if (existingCouponUsage || existingPointShopCouponUsage || existingLotteryUsage) {
      return { status: 'already_used' };
    }

    // expire outdated 8 折券
    await tx.lotteryDraw.updateMany({
      where: {
        jinleeId: userIdentity.jinleeId,
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
        where: { jinleeId: userIdentity.jinleeId, status: CouponStatus.ACTIVE, expiresAt: { lte: now }, type: { in: couponTypes } },
        data: { status: CouponStatus.EXPIRED },
      });
    }

    const findNextDiscountCandidate = async (): Promise<DiscountSelectionCandidate | null> => {
      const availableCoupon = couponTypes.length
        ? await tx.coupon.findFirst({
            where: {
              ...(lotteryId ? { id: lotteryId } : {}),
              jinleeId: userIdentity.jinleeId,
              type: { in: couponTypes },
              status: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
            },
            ...(lotteryId
              ? {}
              : { orderBy: [{ expiresAt: 'asc' as const }, { issuedAt: 'asc' as const }] }),
            select: { id: true, type: true, issuedAt: true, expiresAt: true },
          })
        : null;
      const availablePointShopCoupon = couponTypes.length
        ? await tx.pointShopGrant.findFirst({
            where: {
              ...(lotteryId ? { id: lotteryId } : {}),
              jinleeId: userIdentity.jinleeId,
              deliveryType: PointShopDeliveryType.COUPON,
              couponStatus: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
              couponType: { in: couponTypes },
            },
            ...(lotteryId
              ? {}
              : { orderBy: [{ expiresAt: 'asc' as const }, { issuedAt: 'asc' as const }] }),
            select: { id: true, couponType: true, issuedAt: true, expiresAt: true },
          })
        : null;
      const availableLottery = await tx.lotteryDraw.findFirst({
        where: {
          ...(lotteryId ? { id: lotteryId } : {}),
          jinleeId: userIdentity.jinleeId,
          status: LotteryStatus.UNUSED,
          expiresAt: { gt: now },
          prize: prizeFilter,
        },
        select: { id: true, createdAt: true, expiresAt: true, prize: { select: { name: true } } },
        ...(lotteryId
          ? {}
          : { orderBy: [{ expiresAt: 'asc' as const }, { createdAt: 'asc' as const }] }),
      });

      return pickEarliestExpiryDiscountCandidate([
        availableCoupon
          ? {
              id: availableCoupon.id,
              source: 'coupon',
              expiresAt: availableCoupon.expiresAt,
              issuedAt: availableCoupon.issuedAt,
              couponType: availableCoupon.type,
            }
          : null,
        availablePointShopCoupon?.couponType && availablePointShopCoupon.expiresAt
          ? {
              id: availablePointShopCoupon.id,
              source: 'point_shop_coupon',
              expiresAt: availablePointShopCoupon.expiresAt,
              issuedAt: availablePointShopCoupon.issuedAt,
              couponType: availablePointShopCoupon.couponType,
            }
          : null,
        availableLottery?.prize?.name && availableLottery.expiresAt
          ? {
              id: availableLottery.id,
              source: 'lottery',
              expiresAt: availableLottery.expiresAt,
              issuedAt: availableLottery.createdAt,
              prizeName: availableLottery.prize.name,
            }
          : null,
      ]);
    };

    let selectedDiscount: DiscountSelectionCandidate | null = null;

    for (let attempt = 0; attempt < MAX_DISCOUNT_SELECTION_RETRIES; attempt++) {
      const candidate = await findNextDiscountCandidate();
      if (!candidate) break;

      const prizeNameUsed =
        candidate.source === 'lottery'
          ? candidate.prizeName
          : Object.entries(DISCOUNT_COUPON_TYPE_MAP).find(([, type]) => type === candidate.couponType)?.[0] ?? '';
      const config = DISCOUNT_PRIZE_CONFIG[prizeNameUsed];
      if (!config) {
        if (lotteryId) break;
        continue;
      }
      const candidateDiscountAmount = computeDiscountAmount({
        unitPrice,
        totalMinutes: order.totalMinutes,
        rate: config.rate,
        cap: config.cap,
      });
      if (candidateDiscountAmount.lte(0)) return { status: 'no_fee' };

      const consumed = await consumeDiscountCandidateTx(tx, {
        candidate,
        jinleeId: userIdentity.jinleeId,
        orderId: order.id,
        discountAmount: candidateDiscountAmount,
        workerDiscordUserId: workerIdentity.discordUserId ?? order.workerId ?? null,
        workerJinleeId: workerIdentity.jinleeId,
        now,
      });

      if (consumed) {
        selectedDiscount = candidate;
        break;
      }

      if (lotteryId) {
        break;
      }
    }

    if (!selectedDiscount) return { status: 'no_lottery' };

    const prizeNameUsed =
      selectedDiscount.source === 'lottery'
        ? selectedDiscount.prizeName
        : Object.entries(DISCOUNT_COUPON_TYPE_MAP).find(([, type]) => type === selectedDiscount.couponType)?.[0] ?? '';
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
      kind: selectedDiscount.source === 'lottery' ? 'lottery' : 'coupon',
      consumeAmount: discountAmount,
      ...(selectedDiscount.source === 'lottery'
        ? { lotteryId: selectedDiscount.id }
        : { couponId: selectedDiscount.id }),
    };
  });
}
