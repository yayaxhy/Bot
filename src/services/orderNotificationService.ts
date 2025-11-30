import { order_end_boss_embed, order_end_pw_embed, discount_prompt_embed } from '../ui/orderEmbeds.js';
import prisma from '../db/prisma.js';
import type { Client } from 'discord.js';
import { syncSpentRolesForMember } from './spentRoleService.js';

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

    if (availableCoupons > 0 && !existingUsage) {
      const prompt = discount_prompt_embed(orderLabel, order.id, availableCoupons);
      if (prompt) {
        embeds.push(prompt.embed);
        components = prompt.components;
        console.log('[discount] sending prompt', {
          orderId: order.id,
          hostId: order.hostId,
          availableCoupons,
          destination: 'boss_dm',
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
