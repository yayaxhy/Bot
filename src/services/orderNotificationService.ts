import { order_end_boss_embed, order_end_pw_embed, discount_prompt_embed } from '../ui/orderEmbeds.js';
import prisma from '../db/prisma.js';
import type { Client } from 'discord.js';
import { syncSpentRolesForMember } from './spentRoleService.js';
import { PRIZE_NAMES } from './lotteryService.js';
import { LotteryStatus } from '@prisma/client';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';

async function fetchOrderSummary(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      displayNo: true,
      peiwanId: true,
      totalMinutes: true,
      grossAmount: true,
      netAmount: true,
      hostId: true,
      workerId: true,
      host: { select: { totalBalance: true } },
    },
  });
}

export async function notifyOrderEnded(orderId: string) {
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) {
    console.warn('[notifyOrderEnded] no client instance', { orderId });
    return;
  }

  const order = await fetchOrderSummary(orderId);
  if (!order || !order.hostId || !order.workerId) {
    console.log('[notifyOrderEnded] skip', { orderId, reason: 'missing order or participants' });
    return;
  }
  syncSpentRolesForMember(order.hostId).catch((err) => console.error('[spent-role] schedule failed', err));
  syncSpentRolesForMember(order.workerId, { includeSpendRoles: false }).catch((err) =>
    console.error('[spent-role] schedule failed for worker', err)
  );
  const now = new Date();
  const availableCoupons = await prisma.coupon.count({
    where: {
      discordId: order.hostId,
      type: 'DISCOUNT_90',
      status: 'ACTIVE',
      expiresAt: { gt: now },
    },
  });
  const existingUsage = await prisma.coupon.findFirst({
    where: { orderId, status: 'USED' },
    select: { id: true },
  });

  const lotteryDiscountNames = [
    PRIZE_NAMES.DISCOUNT_80,
    PRIZE_NAMES.DISCOUNT_70,
    PRIZE_NAMES.DISCOUNT_90_LOTTERY,
  ];
  await prisma.lotteryDraw.updateMany({
    where: {
      userId: order.hostId,
      status: LotteryStatus.UNUSED,
      expiresAt: { lte: now },
      prize: { name: { in: lotteryDiscountNames } },
    },
    data: { status: LotteryStatus.EXPIRED },
  });
  const bazheCount = await prisma.lotteryDraw.count({
    where: {
      userId: order.hostId,
      status: LotteryStatus.UNUSED,
      expiresAt: { gt: now },
      prize: { name: PRIZE_NAMES.DISCOUNT_80 },
    },
  });
  const qizheCount = await prisma.lotteryDraw.count({
    where: {
      userId: order.hostId,
      status: LotteryStatus.UNUSED,
      expiresAt: { gt: now },
      prize: { name: PRIZE_NAMES.DISCOUNT_70 },
    },
  });
  const specialJiuzheCount = await prisma.lotteryDraw.count({
    where: {
      userId: order.hostId,
      status: LotteryStatus.UNUSED,
      expiresAt: { gt: now },
      prize: { name: PRIZE_NAMES.DISCOUNT_90_LOTTERY },
    },
  });

  const totalMinutes = order.totalMinutes ?? 0;
  const gross = order.grossAmount ? Number(order.grossAmount.toString()) : 0;
  const net = order.netAmount ? Number(order.netAmount.toString()) : 0;
  const hostBalance = order.host?.totalBalance ? Number(order.host.totalBalance.toString()) : 0;
  const heartInc = Math.max(0, Math.round(gross));
  const heartCounter = await prisma.heartCounter.findUnique({
    where: {
      fromMemberId_toMemberId: {
        fromMemberId: order.hostId,
        toMemberId: order.workerId,
      },
    },
    select: { total: true },
  });
  const currentHeart = heartCounter?.total ?? 0;
  const displayNo = order.displayNo;
  const orderLabel = displayNo != null ? `${ORDER_ID_PREFIX}${displayNo}` : `${ORDER_ID_PREFIX}—`;

  try {
    const boss = await client.users.fetch(order.hostId);
    const embeds = [
      order_end_boss_embed(
        displayNo,
        order.workerId,
        order.peiwanId ?? '—',
        totalMinutes,
        gross,
        hostBalance,
        heartInc,
        currentHeart
      ),
    ];
    let components: any[] = [];

    const totalCoupons = availableCoupons + bazheCount + qizheCount + specialJiuzheCount;
    if (totalCoupons > 0 && !existingUsage) {
      const prompt = discount_prompt_embed(
        orderLabel,
        order.id,
        availableCoupons,
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
          availableCoupons,
          bazheCount,
          qizheCount,
          specialJiuzheCount,
          destination: 'boss_dm',
        });
      } else {
        console.log('[discount] prompt missing', {
          orderId: order.id,
          hostId: order.hostId,
          availableCoupons,
          bazheCount,
          qizheCount,
          specialJiuzheCount,
        });
      }
    } else {
      console.log('[discount] no coupon prompt', {
        orderId: order.id,
        hostId: order.hostId,
        availableCoupons,
        bazheCount,
        qizheCount,
        specialJiuzheCount,
        existingUsage,
      });
    }

    await boss.send({ embeds, components });
  } catch (err) {
    console.error('[notifyOrderEnded] notify boss failed:', err);
  }

  try {
    const worker = await client.users.fetch(order.workerId);
    await worker.send({
      embeds: [
        order_end_pw_embed(
          displayNo,
          order.hostId,
          totalMinutes,
          gross,
          net,
          heartInc,
          currentHeart
        ),
      ],
    });
  } catch (err) {
    console.error('[notifyOrderEnded] notify worker failed:', err);
  }
}
