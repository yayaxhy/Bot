import {
  ButtonInteraction, ChannelType, Client, TextChannel, User,
} from 'discord.js';
import { acceptOrder as acceptOrderService } from '../../services/orderService.js';
import { scheduleForOrder } from '../../services/timerService.js';
import {
  PW_accept_embed,
  invite_success_boss_embed,
  invite_successfully_inDiscord_embed,
  anon_invite_successfully_inDiscord_embed,
} from '../../ui/orderEmbeds.js';
import { OrderMode } from '@prisma/client';
import { markInvitationHandled, isInvitationExpired } from '../../services/orderInteractionManager.js';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const ORDER_PUBLIC_ACCEPT_CHANNEL_IDS = (process.env.ORDER_PUBLIC_ACCEPT_CHANNEL_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

export async function runOrderAcceptanceFlow(client: Client, orderId: string) {
  const order = await acceptOrderService(orderId);
  await scheduleForOrder(orderId);

  let workerUser: User | null = null;
  try {
    workerUser = await client.users.fetch(order.workerId);
    const { embed: workerEmbed, components: workerComponents } = PW_accept_embed(
      order.id,
      order.displayNo ?? null,
      order.hostId,
    );
    await workerUser.send({ embeds: [workerEmbed], components: workerComponents });
  } catch (err) {
    console.error('[runOrderAcceptanceFlow] notify worker failed:', err);
  }

  let bossUser: User | null = null;
  try {
    bossUser = await client.users.fetch(order.hostId);
    const workerMention = workerUser ? workerUser.toString() : `<@${order.workerId}>`;
    const { embed: bossEmbed, components: bossComponents } = invite_success_boss_embed(
      order.id,
      order.displayNo,
      order.peiwanId,
      workerMention,
    );
    await bossUser.send({ embeds: [bossEmbed], components: bossComponents });
  } catch (err) {
    console.error('[runOrderAcceptanceFlow] notify boss failed:', err);
  }

  if (ORDER_PUBLIC_ACCEPT_CHANNEL_IDS.length > 0) {
    const bossTag = bossUser?.tag ?? `<@${order.hostId}>`;
    const workerTag = workerUser?.tag ?? `<@${order.workerId}>`;
    for (const channelId of ORDER_PUBLIC_ACCEPT_CHANNEL_IDS) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) continue;

        const textChannel = channel as TextChannel;
        if (order.mode === OrderMode.REALNAME) {
          await textChannel.send(invite_successfully_inDiscord_embed(bossTag, workerTag));
        } else if (order.mode === OrderMode.ANONYMOUS) {
          await textChannel.send(anon_invite_successfully_inDiscord_embed(workerTag));
        }
      } catch (err) {
        console.error('[runOrderAcceptanceFlow] broadcast failed:', err);
      }
    }
  }

  return { order, workerUser, bossUser };
}

function extractOrderIdFromEmbed(i: ButtonInteraction): string | null {
  const e = i.message.embeds?.[0];
  if (!e) return null;
  const payloads: string[] = [];
  if (e.description) payloads.push(e.description);
  for (const f of e.fields ?? []) {
    if (f?.value) payloads.push(f.value);
  }
  const text = payloads.join('\n');
  // 匹配 “订单号：<可选前缀><id>”
  const m = text.match(/订单号：\s*([A-Za-z0-9_-]*)?([a-z0-9]{25,})/i);
  if (!m) return null;
  const id = m[2];
  return id.startsWith(ORDER_ID_PREFIX) ? id.slice(ORDER_ID_PREFIX.length) : id;
}

export async function handleAcceptOrder(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!(i.customId === 'invite_accept' || i.customId.startsWith('invite:accept'))) return;

  // 优先从 customId 解析，兜底从 embed 文本解析
  let orderId = i.customId.split(':').pop()!;
  if (!orderId || orderId === 'invite_accept' || orderId === 'accept') {
    orderId = extractOrderIdFromEmbed(i) ?? '';
  }
  if (!orderId) {
    await i.reply({ content: '未能识别订单号，请稍后重试。', ephemeral: true });
    return;
  }

  if (isInvitationExpired(orderId)) {
    await i.reply({ content: '邀请已过期，请联系老板重新派单。', ephemeral: true });
    return;
  }

  try {
    if (!i.deferred && !i.replied) {
      try {
        await i.deferUpdate();
      } catch (ackErr) {
        console.error('[handleAcceptOrder] defer update failed:', ackErr);
        return;
      }
    }

    await runOrderAcceptanceFlow(i.client, orderId);
    await markInvitationHandled(orderId);

    // 更新原消息：移除按钮，避免重复交互
    if (i.deferred || i.replied) {
      try {
        await i.editReply({ components: [] });
      } catch (editErr) {
        console.error('[handleAcceptOrder] edit reply failed:', editErr);
      }
    } else {
      await i.update({ components: [] });
    }

  } catch (err) {
    console.error('[handleAcceptOrder] error:', err);
    const errorPayload = { content: '接单失败，不能重复接单', ephemeral: true };
    try {
      if (i.deferred || i.replied) {
        await i.followUp(errorPayload);
      } else {
        await i.reply(errorPayload);
      }
    } catch (replyErr) {
      console.error('[handleAcceptOrder] notify error failed:', replyErr);
    }
  }
}
