import { ButtonInteraction } from 'discord.js';
import prisma from '../../db/prisma.js';
import { OrderStatus } from '@prisma/client';
import { endOrder } from '../../services/orderService.js';
import { cancelOrderTimers } from '../../services/timerService.js';

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
      select: { status: true, hostId: true, workerId: true, displayNo: true },
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

    let endedBySelf = false;
    let alreadyEnded = false;
    try {
      await endOrder(orderId, i.user.id);
      endedBySelf = true;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[handleEndOrderButton] endOrder failed, will check status', { orderId, msg });
      if (msg?.includes('Order not running')) {
        const latest = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
        if (latest?.status === OrderStatus.ENDED) {
          alreadyEnded = true;
        }
      }
      if (!alreadyEnded) {
        throw err;
      }
    }

    cancelOrderTimers(orderId);

    const orderLabel = order.displayNo != null
      ? `${ORDER_ID_PREFIX}${order.displayNo}`
      : `${ORDER_ID_PREFIX}—`;

    try { await i.message.edit({ components: [] }); } catch {}

    if (!alreadyEnded) {
      try {
        // 通知统一由 timerService 触发，避免重复
      } catch (err) {
        console.error('[handleEndOrderButton] notify failed:', err);
      }
    }

    if (alreadyEnded) {
      await i.editReply({ content: `订单 ${orderLabel} 已结单。`, embeds: [] });
      return;
    }

    await i.editReply({
      content: `订单 ${orderLabel} 已结单，结算详情稍后将通过私信发送给老板与陪玩。`,
      embeds: [],
    });

  } catch (err) {
    console.error('[handleEndOrderButton] error:', { orderId, userId: i.user.id, err });
    try { await i.editReply('结单失败，请稍后重试或联系工作人员。'); } catch {}
  }
}
