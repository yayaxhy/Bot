import { ButtonInteraction } from 'discord.js';
import prisma from '../../db/prisma.js';
import { OrderStatus } from '@prisma/client';
import { endOrder } from '../../services/orderService.js';
import { cancelOrderTimers } from '../../services/timerService.js';
import { order_end_boss_embed, order_end_pw_embed } from '../../ui/orderEmbeds.js';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const END_BUTTON_PREFIX = 'order:end:';

export async function handleEndOrderButton(i: ButtonInteraction) {
  if (!i.isButton() || !i.customId.startsWith(END_BUTTON_PREFIX)) return;

  const orderId = i.customId.slice(END_BUTTON_PREFIX.length);
  if (!orderId) {
    if (!i.replied && !i.deferred) await i.reply('未能识别订单号，请稍后重试。');
    return;
  }

  if (!i.deferred && !i.replied) {
    try {
      await i.deferReply();
    } catch (err) {
      console.error('[handleEndOrderButton] defer failed:', err);
      return;
    }
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, hostId: true, workerId: true },
    });
    if (!order) {
      await i.editReply('订单不存在，请确认后再试。');
      return;
    }
    const isHost = order.hostId === i.user.id;
    const isWorker = order.workerId === i.user.id;
    if (!isHost && !isWorker) {
      await i.editReply('只有该订单的老板或陪玩才能使用此按钮结单。');
      return;
    }
    if (order.status !== OrderStatus.RUNNING) {
      await i.editReply('该订单已结单。');
      try { await i.message.edit({ components: [] }); } catch {}
      return;
    }

    await endOrder(orderId, i.user.id);
    cancelOrderTimers(orderId);

    const ended = await prisma.order.findUnique({
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
        worker: { select: { totalBalance: true } },
      },
    });
    if (!ended) {
      await i.editReply('订单已结单，但未能获取订单详情。');
      try { await i.message.edit({ components: [] }); } catch {}
      return;
    }

    const totalMinutes = ended.totalMinutes ?? 0;
    const gross = ended.grossAmount ? Number(ended.grossAmount.toString()) : 0;
    const net = ended.netAmount ? Number(ended.netAmount.toString()) : 0;
    const hostBalance = ended.host?.totalBalance ? Number(ended.host.totalBalance.toString()) : 0;
    const heartInc = Math.max(0, Math.round(gross));
    const heartCounter = await prisma.heartCounter.findUnique({
      where: {
        fromMemberId_toMemberId: {
          fromMemberId: ended.hostId,
          toMemberId: ended.workerId,
        },
      },
      select: { total: true },
    });
    const currentHeart = heartCounter?.total ?? 0;
    const orderDisplay = ended.displayNo ?? ended.id;
    const orderLabel = typeof orderDisplay === 'number'
      ? `${ORDER_ID_PREFIX}${orderDisplay}`
      : `${ORDER_ID_PREFIX}${orderDisplay}`;

    try { await i.message.edit({ components: [] }); } catch {}

    await i.editReply({
      content: `订单 ${orderLabel} 已结单，结算详情稍后将通过私信发送给老板与陪玩。`,
      embeds: [],
    });

    try {
      if (ended.hostId) {
        const boss = await i.client.users.fetch(ended.hostId);
        await boss.send({
          embeds: [
            order_end_boss_embed(
              orderDisplay,
              ended.workerId,
              ended.peiwanId ?? '—',
              totalMinutes,
              gross,
              hostBalance,
              heartInc,
              currentHeart
            ),
          ],
        });
      }
    } catch (notifyErr) {
      console.error('[handleEndOrderButton] notify boss failed:', notifyErr);
    }

    try {
      const worker = await i.client.users.fetch(ended.workerId);
      await worker.send({
        embeds: [
          order_end_pw_embed(
            orderDisplay,
            ended.hostId,
            totalMinutes,
            gross,
            net,
            heartInc,
            currentHeart
          ),
        ],
      });
    } catch (notifyErr) {
      console.error('[handleEndOrderButton] notify worker failed:', notifyErr);
    }
  } catch (err) {
    console.error('[handleEndOrderButton] error:', err);
    try { await i.editReply('结单失败，请稍后重试或联系工作人员。'); } catch {}
  }
}
