// src/events/messageCreate.ts
import {
  Client, GatewayIntentBits, Partials, Message, TextChannel, DMChannel, Guild, User, ThreadChannel, userMention, type TextBasedChannel,
} from 'discord.js';
import dotenv from 'dotenv';
import {
  ongoing_order_request_embed,
  anonymous_ongoing_order_request_embed,
  order_request_sent_successfully_embed,
  order_end_boss_embed,
  order_end_pw_embed,
  invitation_embed,
  parseRoleMentions,
} from '../ui/orderEmbeds.js';
import prisma from '../db/prisma.js';
import { OrderStatus, OrderMode, QuotationCode } from '@prisma/client';
import { endOrder } from '../services/orderService.js';
import { cancelOrderTimers } from '../services/timerService.js';
import {
  registerInvitationMessage,
  scheduleOrderRequestClosure,
  isInvitationExpired,
  markInvitationHandled,
} from '../services/orderInteractionManager.js';
import { runOrderAcceptanceFlow } from '../interactions/buttons/acceptOrder.js';
import { runOrderDeclineFlow } from '../interactions/buttons/declineOrder.js';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const DEFAULT_ALLOWED_ROLE_IDS = [
  '1430923008045744211', // 女陪陪
  '1430923554852962406', // 男陪陪
  '1430923746830581841', // 技术陪陪
];
const configuredRoleIds = process.env.ALLOWED_ROLE_IDS
  ? process.env.ALLOWED_ROLE_IDS.split(',').map((id) => id.trim()).filter(Boolean)
  : [];
const allowedRoleIds = Array.from(new Set([...configuredRoleIds, ...DEFAULT_ALLOWED_ROLE_IDS]));
const orderBroadcastChannelIds = (process.env.ORDER_BROADCAST_CHANNEL_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const orderAnonChannelId = process.env.ORDER_ANON_CHANNEL_ID;
const anonNotifyChannelId = process.env.ANON_NOTIFY_CHANNEL_ID ?? '1440888773172006962';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const END_ORDER_PATTERN = /^!(?:陪玩|老板)结单(?:\s+(\S+))?$/;

let cachedAnonGuild: Guild | null = null;

function priceFromPeiwan(peiwan: any, code: QuotationCode): number | null {
  const key = `quotation_${code}` as keyof typeof peiwan;
  const raw = peiwan?.[key];
  if (raw == null) return null;
  const num = typeof raw === 'number' ? raw : Number(raw?.toString?.());
  return Number.isFinite(num) ? (num as number) : null;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const stripRoleMentions = (text: string) =>
  text.replace(/<@&\d+>/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+/g, '\n').trim();

async function getMemberBalance(discordUserId: string): Promise<number | null> {
  const member = await prisma.member.findUnique({
    where: { discordUserId },
    select: { totalBalance: true },
  });
  if (!member?.totalBalance) return null;
  const numeric = Number(member.totalBalance.toString());
  return Number.isFinite(numeric) ? numeric : null;
}

async function sendAnonLogMessage(client: Client, content: string) {
  if (!anonNotifyChannelId) return;
  try {
    const channel = await client.channels.fetch(anonNotifyChannelId).catch(() => null);
    if (channel && channel.isTextBased() && typeof (channel as TextBasedChannel).send === 'function') {
      await (channel as TextBasedChannel).send({ content, allowedMentions: { parse: ['users'] } });
    }
  } catch (err) {
    console.error('[anon-log] send failed:', err);
  }
}

async function getAnonGuild(message: Message): Promise<Guild | null> {
  if (cachedAnonGuild) return cachedAnonGuild;
  if (!orderAnonChannelId) return null;
  try {
    const channel = await message.client.channels.fetch(orderAnonChannelId);
    if (channel && channel.isTextBased() && 'guild' in channel && channel.guild) {
      cachedAnonGuild = channel.guild;
      return cachedAnonGuild;
    }
  } catch (err) {
    console.error('[messageCreate] fetch anon guild failed:', err);
  }
  return null;
}

async function messageMentionsAllowedRole(message: Message): Promise<boolean> {
  if (allowedRoleIds.length === 0) return false;
  const content = message.content ?? '';
  if (!content) return false;

  if (allowedRoleIds.some((roleId) => content.includes(`<@&${roleId}>`))) {
    return true;
  }

  if (message.guild) {
    return message.mentions.roles.some((role) => allowedRoleIds.includes(role.id));
  }

  const guild = await getAnonGuild(message);
  if (!guild) return false;

  for (const roleId of allowedRoleIds) {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    const namePattern = escapeRegExp(role.name);
    if (new RegExp(`@${namePattern}`, 'i').test(content) || new RegExp(namePattern, 'i').test(content)) {
      return true;
    }
  }
  return false;
}

type OrderIdentifier =
  | { kind: 'display'; value: number }
  | { kind: 'id'; value: string };

type ResolveOrderSuccess = { order: { id: string; displayNo: number | null } };
type ResolveOrderError = {
  error: 'not_found' | 'not_running' | 'not_participant' | 'none_running' | 'multiple';
  candidateOrders?: Array<{ id: string; displayNo: number | null }>;
};

function parseOrderIdentifier(raw?: string | null): OrderIdentifier | null {
  if (!raw) return null;
  let trimmed = raw.trim();
  if (!trimmed) return null;
  if (ORDER_ID_PREFIX && trimmed.startsWith(ORDER_ID_PREFIX)) {
    trimmed = trimmed.slice(ORDER_ID_PREFIX.length);
  }
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? { kind: 'display', value: numeric } : null;
  }
  return { kind: 'id', value: trimmed };
}

async function resolveOrderForCommand(
  userId: string,
  identifier: OrderIdentifier | null
): Promise<ResolveOrderSuccess | ResolveOrderError> {
  if (identifier) {
    const where =
      identifier.kind === 'display'
        ? { displayNo: identifier.value }
        : { id: identifier.value };

    const order = await prisma.order.findUnique({
      where,
      select: { id: true, displayNo: true, status: true, hostId: true, workerId: true },
    });
    if (!order) return { error: 'not_found' };
    if (order.status !== OrderStatus.RUNNING) return { error: 'not_running' };
    if (order.hostId !== userId && order.workerId !== userId) return { error: 'not_participant' };
    return { order: { id: order.id, displayNo: order.displayNo } };
  }

  const orders = await prisma.order.findMany({
    where: {
      status: OrderStatus.RUNNING,
      OR: [{ hostId: userId }, { workerId: userId }],
    },
    select: { id: true, displayNo: true },
  });

  if (orders.length === 0) return { error: 'none_running' };
  if (orders.length > 1) return { error: 'multiple', candidateOrders: orders };
  const [order] = orders;
  return { order };
}

function formatOrderLabel(displayNo: number | null, id: string): string {
  if (displayNo != null) return `${ORDER_ID_PREFIX}${displayNo}`;
  return `${ORDER_ID_PREFIX}${id}`;
}

function extractIdentifierFromText(text?: string | null): OrderIdentifier | null {
  if (!text) return null;
  const match = text.match(/订单号[:：]\s*([^\s“”"']+)/);
  if (!match) return null;
  const raw = match[1];
  return parseOrderIdentifier(raw);
}

async function inferOrderIdentifierFromContext(message: Message): Promise<OrderIdentifier | null> {
  // 1) If replying to a message that contains an order identifier, reuse it.
  const reference = message.reference;
  if (reference?.messageId) {
    try {
      const replied = await message.fetchReference();
      const fromReply =
        extractIdentifierFromText(replied.content)
        ?? extractIdentifierFromText(replied.embeds?.[0]?.description);
      if (fromReply) return fromReply;
      for (const embed of replied.embeds ?? []) {
        for (const field of embed.fields ?? []) {
          const candidate = extractIdentifierFromText(`${field.name} ${field.value}`);
          if (candidate) return candidate;
        }
      }
    } catch (err) {
      console.error('[tryHandleEndOrderCommand] fetchReference failed:', err);
    }
  }

  // 2) Thread channel named like 订单-<id> implies the order id.
  if ('isThread' in message.channel && typeof message.channel.isThread === 'function' && message.channel.isThread()) {
    const thread = message.channel as ThreadChannel;
    const match = thread.name.match(/订单[-_:：]?([A-Za-z0-9-]+)/);
    if (match) {
      const raw = match[1];
      const identifier = parseOrderIdentifier(raw);
      if (identifier) return identifier;
      return { kind: 'id', value: raw };
    }
  }

  // 3) Attempt to parse any embeds on the command message itself.
  const fromSelf =
    extractIdentifierFromText(message.content)
    ?? extractIdentifierFromText(message.embeds?.[0]?.description);
  if (fromSelf) return fromSelf;
  for (const embed of message.embeds ?? []) {
    for (const field of embed.fields ?? []) {
      const candidate = extractIdentifierFromText(`${field.name} ${field.value}`);
      if (candidate) return candidate;
    }
  }

  return null;
}

async function tryHandleEndOrderCommand(message: Message): Promise<boolean> {
  const content = message.content?.trim();
  if (!content) return false;

  const match = content.match(END_ORDER_PATTERN);
  if (!match) return false;

  const providedRaw = match[1]?.trim();
  let identifier = parseOrderIdentifier(providedRaw ?? null);
  if (!identifier) {
    identifier = await inferOrderIdentifierFromContext(message);
  }
  const userId = message.author.id;

  const resolved = await resolveOrderForCommand(userId, identifier);
  if ('error' in resolved) {
    switch (resolved.error) {
      case 'not_found':
        await message.reply('未找到对应的订单，请确认订单号是否正确。');
        return true;
      case 'not_running':
        await message.reply('该订单目前不是进行中状态，无法结单。');
        return true;
      case 'not_participant':
        await message.reply('您不是该订单的参与者，无法结单。');
        return true;
      case 'none_running':
        await message.reply('您当前没有正在进行中的订单。');
        return true;
      case 'multiple': {
        const labels = resolved.candidateOrders?.map((o) => formatOrderLabel(o.displayNo, o.id)) ?? [];
        await message.reply(`检测到多个进行中的订单，请使用“!陪玩结单 <订单号>”或“!老板结单 <订单号>”指定要结单的订单。当前订单：${labels.join(', ')}`);
        return true;
      }
      default:
        return true;
    }
  }

  const { order } = resolved;
  const orderLabel = formatOrderLabel(order.displayNo, order.id);

  try {
    await endOrder(order.id, userId);
    cancelOrderTimers(order.id);
  } catch (err) {
    console.error('[messageCreate:endOrder] endOrder error:', err);
    await message.reply('结单失败，请稍后重试或联系工作人员。');
    return true;
  }

  const ended = await prisma.order.findUnique({
    where: { id: order.id },
    select: {
      id: true,
      displayNo: true,
      peiwanId: true,
      totalMinutes: true,
      grossAmount: true,
      netAmount: true,
      hostId: true,
      workerId: true,
      host: { select: { totalBalance: true, discordUserId: true } },
      worker: { select: { totalBalance: true, discordUserId: true } },
    },
  });

  if (!ended) {
    await message.reply('订单已结单，但未能读取订单详情。');
    return true;
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

  const endedLabel = formatOrderLabel(ended.displayNo, ended.id);

  await message.reply(`订单 ${endedLabel} 已结单。`);

  try {
    const boss = await message.client.users.fetch(ended.hostId);
    await boss.send({
      embeds: [
        order_end_boss_embed(
          ended.displayNo ?? ended.id,
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
  } catch (err) {
    console.error('[messageCreate:endOrder] notify host failed:', err);
  }

  try {
    const worker = await message.client.users.fetch(ended.workerId);
    await worker.send({
      embeds: [
        order_end_pw_embed(
          ended.displayNo ?? ended.id,
          ended.hostId,
          totalMinutes,
          gross,
          net,
          heartInc,
          currentHeart
        ),
      ],
    });
  } catch (err) {
    console.error('[messageCreate:endOrder] notify worker failed:', err);
  }

  return true;
}

async function tryHandleQuickOrderCommand(message: Message): Promise<boolean> {
  const content = message.content?.trim();
  if (!content) return false;
  if (!content.startsWith('!点单')) return false;

  const parts = content.split(/\s+/);
  if (parts.length < 2) {
    await message.reply('用法：`!点单 <陪玩编号>`，例如：`!点单 1101`。');
    return true;
  }

  const peiwanIdNum = Number(parts[1]);
  if (!Number.isInteger(peiwanIdNum) || peiwanIdNum <= 0) {
    await message.reply('陪玩编号无效，请输入正确的数字。');
    return true;
  }

  const isDm = !message.guild;
  if (
    !isDm &&
    orderBroadcastChannelIds.length > 0 &&
    !orderBroadcastChannelIds.includes(message.channel.id)
  ) {
    await message.reply('请在派单频道使用实名点单，或私信机器人使用匿名点单。');
    return true;
  }

  const mode = isDm ? OrderMode.ANONYMOUS : OrderMode.REALNAME;

  try {
    let orderContentForInvite = '';

    const peiwan = await prisma.pEIWAN.findUnique({
      where: { PEIWANID: peiwanIdNum },
      select: {
        PEIWANID: true,
        discordUserId: true,
        defaultQuotationCode: true,
        quotation_Q1: true,
        quotation_Q2: true,
        quotation_Q3: true,
        quotation_Q4: true,
        quotation_Q5: true,
        quotation_Q6: true,
        quotation_Q7: true,
      },
    });
    if (!peiwan) {
      await message.reply(`未找到编号为 ${peiwanIdNum} 的陪玩。`);
      return true;
    }
    if (peiwan.discordUserId === message.author.id) {
      await message.reply('不能点单自己哦。');
      return true;
    }

    const hostMember = await prisma.member.upsert({
      where: { discordUserId: message.author.id },
      create: { discordUserId: message.author.id },
      update: {},
      select: { totalBalance: true },
    });

    const hostBalance = Number(hostMember.totalBalance.toString());
    if (!Number.isFinite(hostBalance) || hostBalance < 100) {
      const staffPing = process.env.SUPPORT_STAFF_USER_ID ? `<@${process.env.SUPPORT_STAFF_USER_ID}>` : '客服';
      await message.reply(`余额不足 100，点单失败。请先充值后再试，可联系 ${staffPing} 获取帮助。`);
      return true;
    }

    const defaultCode = peiwan.defaultQuotationCode as QuotationCode;
    const unitPrice = priceFromPeiwan(peiwan, defaultCode);
    if (unitPrice == null || unitPrice <= 0) {
      await message.reply('该陪玩的默认价格未设置，请联系工作人员。');
      return true;
    }

    const order = await prisma.order.create({
      data: {
        hostId: message.author.id,
        workerId: peiwan.discordUserId,
        peiwanId: peiwan.PEIWANID,
        mode,
        status: OrderStatus.PENDING,
        quotationCode: defaultCode,
        unitPrice,
      },
      select: { id: true, displayNo: true },
    });

    let workerUser: User | null = null;
    try {
      workerUser = await message.client.users.fetch(peiwan.discordUserId);
      const orderContentForInviteRaw = content.replace(/^!点单\s+\S+\s*/, '').trim();
      orderContentForInvite = stripRoleMentions(orderContentForInviteRaw);
      const invitationContent = orderContentForInvite || '请与老板取得联系并开始服务';
      const { embed, components } = invitation_embed(
        order.id,
        order.displayNo,
        message.author.id,
        invitationContent
      );
      const inviteMessage = await workerUser.send({ embeds: [embed], components });
      registerInvitationMessage(order.id, inviteMessage);
    } catch (err) {
      console.error('[quickOrder] send invitation failed:', err);
      await message.reply('无法向陪玩发送邀请，请稍后重试或联系工作人员。');
      return true;
    }

    const orderLabel = `${ORDER_ID_PREFIX}${order.displayNo ?? order.id}`;
    await message.reply(`已向陪玩发送邀请，订单号：${orderLabel}。`);

    if (mode === OrderMode.ANONYMOUS) {
      const balanceLabel = Number.isFinite(hostBalance) ? hostBalance.toFixed(2) : '未知';
      const logContent = [
        '【匿名点单】',
        `点单人：${userMention(message.author.id)} (${message.author.id})`,
        `陪玩：${userMention(peiwan.discordUserId)} (${peiwan.discordUserId})`,
        `订单号：${orderLabel}`,
        `点单内容：${orderContentForInvite || '（无）'}`,
        `点单人余额：${balanceLabel}`,
      ].join('\n');
      await sendAnonLogMessage(message.client, logContent);
    }

    return true;
  } catch (err) {
    console.error('[quickOrder] error:', err);
    await message.reply('点单失败，请稍后再试或联系工作人员。');
    return true;
  }
}

async function tryHandleInviteResponseCommand(message: Message): Promise<boolean> {
  const content = (message.content ?? '').trim();
  if (!content) return false;

  const yesMatch = content.match(/^!yes\.(.+)$/i);
  const noMatch = content.match(/^!no\.(.+)$/i);
  const match = yesMatch ?? noMatch;
  if (!match) return false;

  const rawIdentifier = match[1]?.trim();
  if (!rawIdentifier) {
    await message.reply('请提供订单号，例如 `!yes.12345`。');
    return true;
  }

  const identifier = parseOrderIdentifier(rawIdentifier);
  if (!identifier) {
    await message.reply('订单号格式无效，请检查后再试。');
    return true;
  }

  const where =
    identifier.kind === 'display'
      ? { displayNo: identifier.value }
      : { id: identifier.value };

  const order = await prisma.order.findUnique({
    where,
    select: {
      id: true,
      displayNo: true,
      status: true,
      workerId: true,
      hostId: true,
      mode: true,
      peiwanId: true,
    },
  });

  if (!order) {
    await message.reply('未找到对应的订单，请确认订单号。');
    return true;
  }

  if (order.workerId !== message.author.id) {
    await message.reply('只有被邀请的陪玩才能操作该订单。');
    return true;
  }

  if (order.status !== OrderStatus.PENDING) {
    await message.reply('该订单已处理，请勿重复操作。');
    return true;
  }

  if (isInvitationExpired(order.id)) {
    await message.reply('邀请已过期，请联系老板重新派单。');
    return true;
  }

  const orderLabel = formatOrderLabel(order.displayNo, order.id);

  if (yesMatch) {
    try {
      await runOrderAcceptanceFlow(message.client, order.id);
      await markInvitationHandled(order.id);
      await message.reply(`已接受订单 ${orderLabel}，系统将在 5 分钟后开始计费。`);
    } catch (err: any) {
      console.error('[tryHandleInviteResponseCommand] accept via command failed:', err);
      const msg =
        err?.message === 'ORDER_ALREADY_RUNNING'
          ? '该订单已被接单。'
          : '接单失败，请稍后重试。';
      await message.reply(msg);
    }
    return true;
  }

  if (noMatch) {
    try {
      await runOrderDeclineFlow(message.client, order.id, message.author.id);
      await markInvitationHandled(order.id);
      await message.reply(`已拒绝订单 ${orderLabel}。`);
    } catch (err: any) {
      console.error('[tryHandleInviteResponseCommand] decline via command failed:', err);
      const msg =
        err?.message === 'ORDER_NOT_ASSIGNED_TO_WORKER'
          ? '您不是该订单的指定陪玩，无法操作。'
          : err?.message === 'ORDER_NOT_PENDING'
            ? '该订单已处理，请勿重复操作。'
            : '拒绝失败，请稍后重试。';
      await message.reply(msg);
    }
    return true;
  }

  return false;
}

export const name = 'messageCreate';

export async function execute(message: Message) {
  if (message.author.bot) return;

  const content = message.content;
  const userA = message.author;     // 老板（发单人）
  if (!content || !userA) return;

  if (await tryHandleEndOrderCommand(message)) return;
  if (await tryHandleInviteResponseCommand(message)) return;
  if (await tryHandleQuickOrderCommand(message)) return;

  if (!orderAnonChannelId) return;

  const hasAllowedRole = await messageMentionsAllowedRole(message);

  const originalMsg = content;
  const orderId = message.id;       // 用消息 ID 作为 orderId
  const ownerId = userA.id;         // 🔴 显式传给按钮

  try {
    if (
      orderBroadcastChannelIds.includes(message.channel.id) &&
      hasAllowedRole
    ) {
      const embedResponse = ongoing_order_request_embed(
        userA.tag, content, originalMsg, orderId, ownerId
      );
      if (message.channel instanceof TextChannel || message.channel instanceof DMChannel) {
        await message.channel.send('老板派单啦，快来抢单');
        const posted = await message.channel.send(embedResponse);
        scheduleOrderRequestClosure(posted);
      }

      const { embed: successEmbed } = order_request_sent_successfully_embed(message.id);
      await userA.send({ content: '订单创建成功！', embeds: [successEmbed] });
    } else if (!message.guild) {
      if (hasAllowedRole) {
        const channelB = await message.client.channels.fetch(orderAnonChannelId);
        if (channelB instanceof TextChannel) {
          const roleInfo = parseRoleMentions(content);
          if (roleInfo.mentionText) {
            await channelB.send({
              content: roleInfo.mentionText,
              allowedMentions: { users: [], roles: roleInfo.roleIds, parse: [] },
            });
          }
          const embedResponse = anonymous_ongoing_order_request_embed(
            content, content, orderId, ownerId
          );
          const posted = await channelB.send(embedResponse);
          scheduleOrderRequestClosure(posted);
        }

        const { embed: successEmbed } = order_request_sent_successfully_embed(message.id);
        await userA.send({ content: '订单创建成功！', embeds: [successEmbed] });

        const balance = await getMemberBalance(userA.id);
        const balanceLabel = typeof balance === 'number' && Number.isFinite(balance)
          ? balance.toFixed(2)
          : '未知';
        const logContent = [
          '【匿名派单】',
          `派单人：${userMention(userA.id)} (${userA.id})`,
          `派单内容：${stripRoleMentions(content) || '（无）'}`,
          `派单人余额：${balanceLabel}`,
        ].join('\n');
        await sendAnonLogMessage(message.client, logContent);
      }
    }
  } catch (error) {
    console.error('Error handling the order request:', error);
    try {
      await userA.send({ content: 'Sorry, an error occurred while processing your order request. Please try again later.' });
    } catch {}
  }
}

