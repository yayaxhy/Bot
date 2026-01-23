// src/interactions/button/orderPriceSelect.ts
import {
  Interaction,
  StringSelectMenuInteraction,
  userMention,
  type TextBasedChannel,
} from 'discord.js';
import prisma from '../../db/prisma.js';
import { OrderMode, OrderStatus, QuotationCode } from '@prisma/client';
import { invitation_embed } from '../../ui/orderEmbeds.js';
import { registerInvitationMessage } from '../../services/orderInteractionManager.js';
import { recordOrderRequest } from '../../services/orderRequestLogService.js';
import { updateMemberServerDisplayName } from '../../services/memberDisplayNameService.js';
import { clickStore } from '../../services/clickStore.js';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const SUPPORT_STAFF_USER_ID = process.env.SUPPORT_STAFF_USER_ID ?? '';
const ANON_NOTIFY_CHANNEL_ID = process.env.ANON_NOTIFY_CHANNEL_ID ?? '1440888773172006962';
const ORDER_SELECTED_HINT = '老板点到了心仪的陪玩。派单还未结束，可继续扣单！';

const PEIWAN_ID_FIELD_NAMES = new Set(['PEIWANID', '陪玩ID']);
const ORDER_CONTENT_FIELD_NAMES = new Set(['订单内容']);
const QUOTATION_LABEL: Record<QuotationCode, string> = {
  Q1: '默认单价',
  Q2: 'LoL',
  Q3: 'Valorant',
  Q4: '三角洲',
  Q5: 'CSGO',
  Q6: '永劫',
  Q7: 'Apex',
};
const PRICE_FIELD_BY_CODE: Record<QuotationCode, string> = {
  Q1: 'quotation_Q1',
  Q2: 'lolPrice',
  Q3: 'valPrice',
  Q4: 'deltaPrice',
  Q5: 'csgoPrice',
  Q6: 'narakaPrice',
  Q7: 'apexPrice',
};
const stripRoleMentions = (text: string) =>
  text.replace(/<@&\d+>/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
const isPeiwanIdFieldName = (name?: string | null) => {
  if (!name) return false;
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  return PEIWAN_ID_FIELD_NAMES.has(trimmed) || PEIWAN_ID_FIELD_NAMES.has(upper);
};

function hasSend(channel: unknown): channel is TextBasedChannel & { send: Function } {
  return !!channel && typeof (channel as any).send === 'function';
}

/**
 * 从 Embed 字段中提取陪玩 ID（兼容旧字段名 "PEIWANID"）
 */
function getPeiwanIdFromEmbed(i: StringSelectMenuInteraction): number | null {
  const embed = i.message.embeds?.[0];
  const fields = (embed?.fields ?? []);
  const f = fields.find(x => isPeiwanIdFieldName(x?.name));
  if (!f) return null;
  const raw = String(f.value ?? '').trim();
  const match = raw.match(/\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function getOrderContentFromEmbed(i: StringSelectMenuInteraction): string {
  const embed = i.message.embeds?.[0];
  const fields = embed?.fields ?? [];
  const field = fields.find((x) => {
    const name = (x?.name ?? '').trim();
    if (!name) return false;
    if (ORDER_CONTENT_FIELD_NAMES.has(name)) return true;
    return name.includes('订单内容');
  });
  let value = field?.value ? String(field.value).trim() : '';
  const description = embed?.description ?? '';
  if (!value && description) {
    const fieldMatch = description.match(/订单内容[:：]\s*([\s\S]+)/);
    if (fieldMatch) value = fieldMatch[1].trim();
    if (!value) {
      const quoteMatch = description.match(/“([\s\S]+?)”/);
      if (quoteMatch) value = quoteMatch[1].trim();
    }
  }
  return stripRoleMentions(value).slice(0, 1024);
}

/**
 * 读取陪玩的某一档位价格
 */
function getUnitPrice(peiwan: any, code: QuotationCode): number | null {
  const key = PRICE_FIELD_BY_CODE[code];
  const raw = peiwan?.[key];
  if (raw == null) return null;
  const num = typeof raw === 'number' ? raw : Number(String(raw));
  return Number.isFinite(num) ? num : null;
}

async function sendAnonLogMessage(i: StringSelectMenuInteraction, content: string) {
  if (!ANON_NOTIFY_CHANNEL_ID) return;
  try {
    const channel = await i.client.channels.fetch(ANON_NOTIFY_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased() && hasSend(channel)) {
      await channel.send({ content, allowedMentions: { parse: ['users'] } });
    }
  } catch (err) {
    console.error('[orderPriceSelect] anon log send failed:', err);
  }
}

/**
 * 处理老板在 MP 上选择报价档位（实名/匿名）后的创建订单与发邀请
 *
 * 要求：
 * - 下拉 customId 必须是 'realname_box' 或 'anonymous_box'（见 orderEmbeds.buildQuotationSelect）
 * - embed 字段包含 { name: '陪玩ID', value: '<number>' }（兼容旧值 "PEIWANID"）
 */
export async function handleOrderPriceSelect(i: Interaction) {
  if (!i.isStringSelectMenu()) return;
  const [customIdBase, customOrderId] = i.customId.split(':');
  if (customIdBase !== 'realname_box' && customIdBase !== 'anonymous_box') return;

  const mode: OrderMode = (customIdBase === 'realname_box') ? OrderMode.REALNAME : OrderMode.ANONYMOUS;
  const orderIdFromCustom = customOrderId && customOrderId.trim() ? customOrderId.trim() : null;

  // 1) 解析所选报价档位（Q1..Q7）
  const codeStr = i.values?.[0];
  if (!codeStr) {
    return i.reply({ content: '请选择一个有效的价格档位。', ephemeral: true });
  }
  const quotationCode = codeStr as QuotationCode;
  const quotationLabel = QUOTATION_LABEL[quotationCode] ?? quotationCode;

  // 2) 从 embed 取出陪玩 ID
  const peiwanId = getPeiwanIdFromEmbed(i);
  if (peiwanId == null) {
    return i.reply({ content: '未能识别陪玩的编号（陪玩ID）。', ephemeral: true });
  }
  const orderContentFromEmbed = getOrderContentFromEmbed(i);

  // 3) 查陪玩，得到 workerId（discordUserId）以及对应档位价格
  const peiwan = await prisma.pEIWAN.findUnique({
    where: { PEIWANID: peiwanId },
    select: {
      PEIWANID: true,
      discordUserId: true,
      commissionRate: true,
      techTag: true,
      MP_url: true,
      quotation_Q1: true,
      lolPrice: true,
      valPrice: true,
      deltaPrice: true,
      csgoPrice: true,
      narakaPrice: true,
      apexPrice: true,
    },
  });
  if (!peiwan) {
    return i.reply({ content: `未找到陪玩（ID: ${peiwanId}）。`, ephemeral: false });
  }

  const unitPrice = getUnitPrice(peiwan, quotationCode);
  if (unitPrice == null || unitPrice <= 0) {
    return i.reply({ content: `该价格档位暂不可用：${quotationLabel}。`, ephemeral: true });
  }

  // 3.5) 校验老板余额（最低 100）
  const hostMember = await prisma.member.findUnique({
    where: { discordUserId: i.user.id },
    select: { totalBalance: true },
  });
  if (!hostMember) {
    await i.reply({ content: '未找到您的账户信息，请联系工作人员协助处理。', ephemeral: true });
    return;
  }
  const hostBalance = Number(hostMember.totalBalance.toString());
  if (!Number.isFinite(hostBalance) || hostBalance < 100) {
    const staffPing = SUPPORT_STAFF_USER_ID ? `<@${SUPPORT_STAFF_USER_ID}>` : '客服';
    await i.reply({
      content: `余额不足 100，点单失败。请先充值后再试，可联系 ${staffPing} 获取帮助。`,
      ephemeral: true,
    });
    return;
  }

  // 4) 创建订单（PENDING）
  const hostId = i.user.id; // 老板
  const workerId = peiwan.discordUserId;

  const order = await prisma.order.create({
    data: {
      hostId,
      workerId,
      peiwanId: peiwan.PEIWANID,
      mode,
      status: OrderStatus.PENDING,
      quotationCode,
      unitPrice,
    },
    select: { id: true, displayNo: true },
  });

  const requestContent = [
    `点单给 <@${workerId}>`,
    `陪玩ID:${peiwan.PEIWANID}`,
    orderContentFromEmbed || '',
  ]
    .join(' ')
    .trim();
  const ownerDisplayName =
    i.member && typeof i.member === 'object' && 'displayName' in i.member
      ? (i.member.displayName as string | undefined)
      : (i.user.globalName ?? i.user.username ?? null);
  updateMemberServerDisplayName(prisma, hostId, ownerDisplayName).catch(() => {});
  recordOrderRequest({
    orderId: order.id,
    ownerId: hostId,
    content: requestContent || `点单给 <@${workerId}>`,
    ownerDisplayName: ownerDisplayName ?? null,
  }).catch(() => {});

  // 5) 私信陪玩：发送邀请嵌入
  try {
    const workerUser = await i.client.users.fetch(workerId);
    const gameContent = orderContentFromEmbed || '请与老板取得联系并开始服务';
    const priceLabel = `¥${unitPrice.toFixed(2)}/小时（${quotationLabel}）`;
    const { embed, components } = invitation_embed(order.id, order.displayNo, hostId, gameContent, priceLabel);
    const inviteMessage = await workerUser.send({ embeds: [embed], components });
    registerInvitationMessage(order.id, inviteMessage);
  } catch {
    // 如果无法私信陪玩，忽略（可选：在后台记录日志）
  }

  // 6) 回复老板（交互完成）
  const orderLabel = order.displayNo != null
    ? `${ORDER_ID_PREFIX}${order.displayNo}`
    : `${ORDER_ID_PREFIX}—`;
  const shouldBeEphemeral = i.inGuild();
  await i.reply({
    content: `已向陪玩 ${userMention(workerId)} 发送邀请，请等待对方接单。\n订单号：${orderLabel}\n选择价格： ¥${unitPrice.toFixed(2)}`,
    ephemeral: shouldBeEphemeral,
  });

  // 公告：老板已点到心仪的陪玩（仅公会频道编辑“提示”消息，不改按钮消息）
  if (i.inGuild() && orderIdFromCustom) {
    const hintMsgs = clickStore.getMessages(orderIdFromCustom, 'hint');
    for (const msg of hintMsgs) {
      try {
        const channel = await i.client.channels.fetch(msg.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) continue;
        const m = await (channel as TextBasedChannel).messages.fetch(msg.messageId).catch(() => null);
        if (!m) continue;
        await m.edit({ content: ORDER_SELECTED_HINT });
      } catch (err) {
        console.warn('[orderPriceSelect] failed to edit broadcast message', err);
      }
    }
  }

  if (mode === OrderMode.ANONYMOUS) {
    const balanceLabel = Number.isFinite(hostBalance) ? hostBalance.toFixed(2) : '未知';
    const logContent = [
      '【匿名点单】',
      `点单人：${userMention(hostId)} (${hostId})`,
      `陪玩：${userMention(workerId)} (${workerId})`,
      `订单号：${orderLabel}`,
      `点单内容：${orderContentFromEmbed || '（无）'}`,
      `点单人余额：${balanceLabel}`,
    ].join('\n');
    await sendAnonLogMessage(i, logContent);
  }
}
