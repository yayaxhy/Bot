import { order_end_boss_embed, order_end_pw_embed, discount_prompt_embed } from '../ui/orderEmbeds.js';
import prisma from '../db/prisma.js';
import type { Client } from 'discord.js';
import { resolveJinleeIdentityTx } from './jinleeAccountService.js';
import { scheduleSpentRoleSync } from './spentRoleService.js';
import { PRIZE_NAMES } from './lotteryService.js';
import { CouponStatus, CouponType, LotteryStatus, PointShopDeliveryType } from '@prisma/client';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const notifiedOrders = new Map<string, number>();
const NOTIFY_DEDUP_MS = 2 * 60 * 1000;
const LEGACY_DISCOUNT_90_NAME = '特殊九折券';
const DISCOUNT_COUPON_TYPES = [
  CouponType.DISCOUNT_90,
  CouponType.DISCOUNT_80,
  CouponType.DISCOUNT_70,
  CouponType.DISCOUNT_90_LOTTERY,
] as const;

function isExpectedDiscordDeliveryError(err: unknown): boolean {
  const error = err as { code?: number | string; message?: string } | null;
  const code = typeof error?.code === 'number' ? error.code : Number(error?.code);
  const message = typeof error?.message === 'string' ? error.message : '';
  return (
    code === 50007
    || code === 50001
    || code === 10013
    || message.includes('Cannot send messages to this user')
    || message.includes('Missing Access')
    || message.includes('Unknown User')
  );
}

function logDiscordDeliveryResult(
  context: 'boss_dm' | 'worker_dm',
  orderId: string,
  discordUserId: string,
  err: unknown,
) {
  const error = err as { code?: number | string; message?: string } | null;
  const payload = {
    orderId,
    discordUserId,
    code: error?.code ?? null,
    message: error?.message ?? String(err),
  };
  if (isExpectedDiscordDeliveryError(err)) {
    console.log('[notifyOrderEnded] delivery skipped', { context, ...payload });
    return;
  }
  console.error('[notifyOrderEnded] delivery failed', { context, ...payload, err });
}

function shouldNotify(orderId: string): boolean {
  const now = Date.now();
  const prev = notifiedOrders.get(orderId);
  if (prev && now - prev < NOTIFY_DEDUP_MS) return false;
  notifiedOrders.set(orderId, now);
  return true;
}

function cleanupNotified() {
  const now = Date.now();
  for (const [orderId, ts] of notifiedOrders.entries()) {
    if (now - ts > NOTIFY_DEDUP_MS) notifiedOrders.delete(orderId);
  }
}

async function fetchOrderSummary(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      displayNo: true,
      peiwanId: true,
      totalMinutes: true,
      chargedMinutes: true,
      grossAmount: true,
      netAmount: true,
      hostId: true,
      hostJinleeId: true,
      workerId: true,
      host: { select: { totalBalance: true } },
    },
  });
}

export async function notifyOrderEnded(orderId: string) {
  cleanupNotified();
  if (!shouldNotify(orderId)) {
    console.log('[notifyOrderEnded] skip duplicate', { orderId });
    return;
  }

  // DB-level dedup: only the first caller can set notifiedAt
  const updated = await prisma.order.updateMany({
    where: { id: orderId, notifiedAt: null },
    data: { notifiedAt: new Date() },
  });
  if (updated.count === 0) {
    console.log('[notifyOrderEnded] skip duplicate (db)', { orderId });
    return;
  }

  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) {
    console.warn('[notifyOrderEnded] no client instance', { orderId });
    return;
  }

  const order = await fetchOrderSummary(orderId);
  if (!order || !order.workerId) {
    console.log('[notifyOrderEnded] skip', { orderId, reason: 'missing order or participants' });
    return;
  }
  const hostIdentity =
    order.hostJinleeId
      ? { jinleeId: order.hostJinleeId, discordUserId: order.hostId ?? null }
      : order.hostId
        ? await resolveJinleeIdentityTx(prisma, order.hostId)
        : null;
  if (order.hostId) {
    scheduleSpentRoleSync(order.hostId, { announceVipUpgrade: true });
  }
  scheduleSpentRoleSync(order.workerId, { includeSpendRoles: false });
  const now = new Date();
  const hostJinleeId = hostIdentity?.jinleeId ?? null;
  const [
    availableCoupons,
    bazheCouponCount,
    qizheCouponCount,
    specialJiuzheCouponCount,
    availablePointShopCoupons,
    bazhePointShopCouponCount,
    qizhePointShopCouponCount,
    specialJiuzhePointShopCouponCount,
  ] = await Promise.all([
    hostJinleeId
      ? prisma.coupon.count({
          where: {
            jinleeId: hostJinleeId,
            type: CouponType.DISCOUNT_90,
            status: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
          },
        })
      : Promise.resolve(0),
    hostJinleeId
      ? prisma.coupon.count({
          where: {
            jinleeId: hostJinleeId,
            type: CouponType.DISCOUNT_80,
            status: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
          },
        })
      : Promise.resolve(0),
    hostJinleeId
      ? prisma.coupon.count({
          where: {
            jinleeId: hostJinleeId,
            type: CouponType.DISCOUNT_70,
            status: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
          },
        })
      : Promise.resolve(0),
    hostJinleeId
      ? prisma.coupon.count({
          where: {
            jinleeId: hostJinleeId,
            type: CouponType.DISCOUNT_90_LOTTERY,
            status: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
          },
        })
      : Promise.resolve(0),
    hostJinleeId
      ? prisma.pointShopGrant.count({
          where: {
            jinleeId: hostJinleeId,
            deliveryType: PointShopDeliveryType.COUPON,
            couponStatus: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
            couponType: CouponType.DISCOUNT_90,
          },
        })
      : Promise.resolve(0),
    hostJinleeId
      ? prisma.pointShopGrant.count({
          where: {
            jinleeId: hostJinleeId,
            deliveryType: PointShopDeliveryType.COUPON,
            couponStatus: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
            couponType: CouponType.DISCOUNT_80,
          },
        })
      : Promise.resolve(0),
    hostJinleeId
      ? prisma.pointShopGrant.count({
          where: {
            jinleeId: hostJinleeId,
            deliveryType: PointShopDeliveryType.COUPON,
            couponStatus: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
            couponType: CouponType.DISCOUNT_70,
          },
        })
      : Promise.resolve(0),
    hostJinleeId
      ? prisma.pointShopGrant.count({
          where: {
            jinleeId: hostJinleeId,
            deliveryType: PointShopDeliveryType.COUPON,
            couponStatus: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
            couponType: CouponType.DISCOUNT_90_LOTTERY,
          },
        })
      : Promise.resolve(0),
  ]);

  const lotteryDiscountNames = [
    PRIZE_NAMES.DISCOUNT_80,
    PRIZE_NAMES.DISCOUNT_70,
    PRIZE_NAMES.DISCOUNT_90_LOTTERY,
    LEGACY_DISCOUNT_90_NAME,
  ];
  if (hostJinleeId) {
    await prisma.lotteryDraw.updateMany({
      where: {
        jinleeId: hostJinleeId,
        status: LotteryStatus.UNUSED,
        expiresAt: { lte: now },
        prize: { name: { in: lotteryDiscountNames } },
      },
      data: { status: LotteryStatus.EXPIRED },
    });
  }
  const bazheLotteryCount = hostJinleeId
    ? await prisma.lotteryDraw.count({
        where: {
          jinleeId: hostJinleeId,
          status: LotteryStatus.UNUSED,
          expiresAt: { gt: now },
          prize: { name: PRIZE_NAMES.DISCOUNT_80 },
        },
      })
    : 0;
  const qizheLotteryCount = hostJinleeId
    ? await prisma.lotteryDraw.count({
        where: {
          jinleeId: hostJinleeId,
          status: LotteryStatus.UNUSED,
          expiresAt: { gt: now },
          prize: { name: PRIZE_NAMES.DISCOUNT_70 },
        },
      })
    : 0;
  const specialJiuzheLotteryCount = hostJinleeId
    ? await prisma.lotteryDraw.count({
        where: {
          jinleeId: hostJinleeId,
          status: LotteryStatus.UNUSED,
          expiresAt: { gt: now },
          prize: { name: { in: [PRIZE_NAMES.DISCOUNT_90_LOTTERY, LEGACY_DISCOUNT_90_NAME] } },
        },
      })
    : 0;
  const existingUsage = hostJinleeId
    ? await Promise.all([
        prisma.coupon.findFirst({
          where: { orderId, status: CouponStatus.USED },
          select: { id: true },
        }),
        prisma.pointShopGrant.findFirst({
          where: {
            consumeOrderId: orderId,
            jinleeId: hostJinleeId,
            deliveryType: PointShopDeliveryType.COUPON,
            couponStatus: CouponStatus.USED,
            couponType: { in: [...DISCOUNT_COUPON_TYPES] },
          },
          select: { id: true },
        }),
        prisma.lotteryDraw.findFirst({
          where: {
            jinleeId: hostJinleeId,
            status: LotteryStatus.USED,
            consumeOrderId: orderId,
            prize: { name: { in: lotteryDiscountNames } },
          },
          select: { id: true },
        }),
      ]).then(([couponUsage, pointShopUsage, lotteryUsage]) => couponUsage ?? pointShopUsage ?? lotteryUsage)
    : null;
  const totalJiuzheCount = availableCoupons + availablePointShopCoupons;
  const bazheCount = bazheLotteryCount + bazheCouponCount + bazhePointShopCouponCount;
  const qizheCount = qizheLotteryCount + qizheCouponCount + qizhePointShopCouponCount;
  const specialJiuzheCount =
    specialJiuzheLotteryCount + specialJiuzheCouponCount + specialJiuzhePointShopCouponCount;

  const totalMinutes = order.totalMinutes ?? 0;
  const chargedMinutes = order.chargedMinutes ?? 0;
  const gross = order.grossAmount ? Number(order.grossAmount.toString()) : 0;
  const net = order.netAmount ? Number(order.netAmount.toString()) : 0;
  const hostBalance = order.host?.totalBalance ? Number(order.host.totalBalance.toString()) : 0;
  const heartInc = Math.max(0, Math.round(gross));
  const heartCounter = order.hostId
    ? await prisma.heartCounter.findUnique({
        where: {
          fromMemberId_toMemberId: {
            fromMemberId: order.hostId,
            toMemberId: order.workerId,
          },
        },
        select: { total: true },
      })
    : null;
  const currentHeart = heartCounter?.total ?? 0;
  const pointsTotal = hostJinleeId
    ? Number(
        (
          await prisma.jinleeUser.findUnique({
            where: { jinleeId: hostJinleeId },
            select: { loyaltyPoints: true },
          })
        )?.loyaltyPoints?.toString() ?? '0'
      )
    : 0;
  const pointsEarned = Math.max(0, gross);
  const displayNo = order.displayNo;
  const orderLabel = displayNo != null ? `${ORDER_ID_PREFIX}${displayNo}` : `${ORDER_ID_PREFIX}—`;

  if (order.hostId) {
    try {
      const boss = await client.users.fetch(order.hostId);
    const embeds = [
      order_end_boss_embed(
        displayNo,
        order.workerId,
        order.peiwanId ?? '—',
        totalMinutes,
        chargedMinutes,
        gross,
        hostBalance,
        heartInc,
        currentHeart,
        pointsEarned,
        pointsTotal
      ),
    ];
    let components: any[] = [];

    const totalCoupons = totalJiuzheCount + bazheCount + qizheCount + specialJiuzheCount;
    if (totalCoupons > 0 && !existingUsage) {
      const prompt = discount_prompt_embed(
        orderLabel,
        order.id,
        totalJiuzheCount,
        bazheCount,
        qizheCount,
        specialJiuzheCount
      );
      if (prompt) {
        embeds.push(prompt.embed);
        components = prompt.components;
        console.log('[discount] sending prompt', {
          orderId: order.id,
          hostId: order.hostId,
          availableCoupons: totalJiuzheCount,
          bazheCount,
          qizheCount,
          specialJiuzheCount,
          destination: 'boss_dm',
        });
      } else {
        console.log('[discount] prompt missing', {
          orderId: order.id,
          hostId: order.hostId,
          availableCoupons: totalJiuzheCount,
          bazheCount,
          qizheCount,
          specialJiuzheCount,
        });
      }
    } else {
      console.log('[discount] no coupon prompt', {
        orderId: order.id,
        hostId: order.hostId,
        availableCoupons: totalJiuzheCount,
        bazheCount,
        qizheCount,
        specialJiuzheCount,
        existingUsage,
      });
    }

    await boss.send({ embeds, components });
    } catch (err) {
      logDiscordDeliveryResult('boss_dm', order.id, order.hostId, err);
    }
  }

  try {
    const worker = await client.users.fetch(order.workerId);
    await worker.send({
      embeds: [
        order_end_pw_embed(
          displayNo,
          order.hostId,
          totalMinutes,
          chargedMinutes,
          gross,
          net,
          heartInc,
          currentHeart
        ),
      ],
    });
  } catch (err) {
    logDiscordDeliveryResult('worker_dm', order.id, order.workerId, err);
  }
}
