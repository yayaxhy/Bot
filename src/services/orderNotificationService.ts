import { order_end_boss_embed, order_end_pw_embed, discount_prompt_embed } from '../ui/orderEmbeds.js';
import prisma from '../db/prisma.js';
import type { Client } from 'discord.js';

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
  if (!client) return;

  const order = await fetchOrderSummary(orderId);
  if (!order || !order.hostId || !order.workerId) {
    console.log('[notifyOrderEnded] skip', { orderId, reason: 'missing order or participants' });
    return;
  }
  const now = new Date();
  const [availableCoupons, existingUsage] = await Promise.all([
    prisma.coupon.count({
      where: {
        discordId: order.hostId,
        type: 'DISCOUNT_90',
        status: 'ACTIVE',
        expiresAt: { gt: now },
      },
    }),
    prisma.coupon.findFirst({
      where: { orderId, status: 'USED' },
      select: { id: true },
    }),
  ]);

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
  const orderDisplay = order.displayNo ?? order.id;

  try {
    const boss = await client.users.fetch(order.hostId);
    await boss.send({
      embeds: [
        order_end_boss_embed(
          orderDisplay,
          order.workerId,
          order.peiwanId ?? '—',
          totalMinutes,
          gross,
          hostBalance,
          heartInc,
          currentHeart
        ),
      ],
    });
    if (availableCoupons > 0 && !existingUsage) {
      const prompt = discount_prompt_embed(orderDisplay.toString(), order.id, availableCoupons);
      if (prompt) {
        console.log('[discount] sending prompt', {
          orderId: order.id,
          hostId: order.hostId,
          availableCoupons,
        });
        await boss.send({
          embeds: [prompt.embed],
          components: prompt.components,
        });
      } else {
        console.log('[discount] prompt missing', {
          orderId: order.id,
          hostId: order.hostId,
          availableCoupons,
        });
      }
    } else {
      console.log('[discount] no coupon prompt', {
        orderId: order.id,
        hostId: order.hostId,
        availableCoupons,
        existingUsage,
      });
    }
  } catch (err) {
    console.error('[notifyOrderEnded] notify boss failed:', err);
  }

  try {
    const worker = await client.users.fetch(order.workerId);
    await worker.send({
      embeds: [
        order_end_pw_embed(
          orderDisplay,
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
