import {
  ButtonInteraction, Client,
} from 'discord.js';
import prisma from '../../db/prisma.js';
import {
  PW_decline_embed,
  refuse_order_request_embed,
} from '../../ui/orderEmbeds.js';
import { OrderStatus } from '@prisma/client';
import { markInvitationHandled, isInvitationExpired } from '../../services/orderInteractionManager.js';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';

function extractOrderIdFromEmbed(i: ButtonInteraction): string | null {
  const e = i.message.embeds?.[0];
  if (!e) return null;
  const payloads: string[] = [];
  if (e.description) payloads.push(e.description);
  for (const f of e.fields ?? []) {
    if (f?.value) payloads.push(f.value);
  }
  const text = payloads.join('\n');
  const m = text.match(/订单号：\s*([A-Za-z0-9_-]*)?([a-z0-9]{25,})/i);
  if (!m) return null;
  const id = m[2];
  return id.startsWith(ORDER_ID_PREFIX) ? id.slice(ORDER_ID_PREFIX.length) : id;
}

export async function runOrderDeclineFlow(client: Client, orderId: string, workerId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      workerId: true,
      hostId: true,
      peiwanId: true,
      displayNo: true,
    },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.workerId !== workerId) throw new Error('ORDER_NOT_ASSIGNED_TO_WORKER');
  if (order.status !== OrderStatus.PENDING) throw new Error('ORDER_NOT_PENDING');

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current) throw new Error('ORDER_NOT_FOUND');

    if (current.status === OrderStatus.PENDING) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.DECLINED, endedAt: new Date() },
      });
      await tx.pEIWAN.update({
        where: { PEIWANID: current.peiwanId },
        data: { status: 'free' as any },
      });
    }

    return tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        workerId: true,
        hostId: true,
        peiwanId: true,
        displayNo: true,
        status: true,
      },
    });
  });

  try {
    const worker = await client.users.fetch(workerId);
    const wEmbed = PW_decline_embed(updated.hostId);
    await worker.send({ embeds: [wEmbed] });
  } catch (err) {
    console.error('[runOrderDeclineFlow] notify worker failed:', err);
  }

  try {
    const boss = await client.users.fetch(updated.hostId);
    const workerMention = updated.workerId ? `<@${updated.workerId}>` : '';
    const bEmbed = refuse_order_request_embed(
      updated.peiwanId,
      updated.displayNo,
      workerMention,
    );
    await boss.send({ embeds: [bEmbed] });
  } catch (err) {
    console.error('[runOrderDeclineFlow] notify boss failed:', err);
  }

  return updated;
}

export async function handleDeclineOrder(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!(i.customId === 'invite_decline' || i.customId.startsWith('invite:decline'))) return;

  let orderId = i.customId.split(':').pop()!;
  if (!orderId || orderId === 'invite_decline' || orderId === 'decline') {
    orderId = extractOrderIdFromEmbed(i) ?? '';
  }
  if (!orderId) {
    await i.reply({ content: '未能识别订单号，请稍后重试。', ephemeral: true });
    return;
  }

  if (isInvitationExpired(orderId)) {
    await i.reply({ content: '邀请已过期，无法拒绝。', ephemeral: true });
    return;
  }

  try {
    await runOrderDeclineFlow(i.client, orderId, i.user.id);
    await markInvitationHandled(orderId);

    // 立刻更新原消息：移除按钮，避免交互失败
    await i.update({ components: [] });

  } catch (err: any) {
    console.error('[handleDeclineOrder] error:', err);
    if (!i.replied && !i.deferred) {
      const msg =
        err?.message === 'ORDER_NOT_ASSIGNED_TO_WORKER'
          ? '您不是该订单的指定陪玩，无法操作。'
          : err?.message === 'ORDER_NOT_PENDING'
            ? '该订单已处理，请勿重复操作。'
            : '已拒绝或处理失败，请稍后重试。';
      await i.reply({ content: msg, ephemeral: true });
    }
  }
}
