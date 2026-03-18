// src/events/messageCreate.ts
import {
  ActionRowBuilder,
  Client,
  DMChannel,
  EmbedBuilder,
  GatewayIntentBits,
  Message,
  Partials,
  StringSelectMenuBuilder,
  TextChannel,
  Guild,
  ThreadChannel,
  userMention,
  type TextBasedChannel,
} from 'discord.js';
import dotenv from 'dotenv';
import {
  ongoing_order_request_embed,
  anonymous_ongoing_order_request_embed,
  order_request_sent_successfully_embed,
  order_end_boss_embed,
  order_end_pw_embed,
  buildQuotationSelect,
  parseRoleMentions,
} from '../ui/orderEmbeds.js';
import prisma from '../db/prisma.js';
import { OrderStatus, OrderMode, QuotationCode } from '@prisma/client';
import { endOrder } from '../services/orderService.js';
import { cancelOrderTimers } from '../services/timerService.js';
import {
  scheduleOrderRequestClosure,
  isInvitationExpired,
  markInvitationHandled,
} from '../services/orderInteractionManager.js';
import { runOrderAcceptanceFlow } from '../interactions/buttons/acceptOrder.js';
import { runOrderDeclineFlow } from '../interactions/buttons/declineOrder.js';
import { handleLotteryMessage } from '../commands/lottery.js';
import { handleRenameCardCommand } from '../commands/renameCard.js';
import { clickStore } from '../services/clickStore.js';
import { recordOrderRequest } from '../services/orderRequestLogService.js';
import { updateMemberServerDisplayName } from '../services/memberDisplayNameService.js';
import { getActiveActivities } from '../services/activityService.js';
import {
  GENERAL_BROADCAST_CHANNEL_ID,
  getOrderChannelBindingSnapshot,
} from '../services/orderChannelBindingService.js';

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
const configuredBroadcastChannelIds = (process.env.ORDER_BROADCAST_CHANNEL_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const orderAnonChannelId = process.env.ORDER_ANON_CHANNEL_ID;
const anonNotifyChannelId = process.env.ANON_NOTIFY_CHANNEL_ID ?? '1440888773172006962';
const DEFAULT_EMBED_COLOR = 0xf5a623;

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const END_ORDER_PATTERN = /^!(?:陪玩|老板)结单(?:\s+(\S+))?$/;

let cachedAnonGuild: Guild | null = null;
const isMissingAccessError = (err: any) =>
  err?.code === 50001 || (typeof err?.message === 'string' && err.message.includes('Missing Access'));
const safeFetchChannel = async (client: Client, channelId: string, context: string) => {
  try {
    return await client.channels.fetch(channelId);
  } catch (err) {
    if (isMissingAccessError(err)) return null;
    console.error(`[messageCreate] ${context} fetch failed:`, err);
    return null;
  }
};
const safeSend = async (action: () => Promise<unknown>, context: string) => {
  try {
    await action();
  } catch (err) {
    if (isMissingAccessError(err)) return;
    console.error(`[messageCreate] ${context} send failed:`, err);
  }
};

const PRICE_FIELD_BY_CODE: Record<QuotationCode, string> = {
  Q1: 'quotation_Q1',
  Q2: 'lolPrice',
  Q3: 'valPrice',
  Q4: 'deltaPrice',
  Q5: 'csgoPrice',
  Q6: 'narakaPrice',
  Q7: 'apexPrice',
  Q8: 'owPrice',
  Q9: 'tftPrice',
  Q10: 'steamPrice',
};

function priceFromPeiwan(peiwan: any, code: QuotationCode): number | null {
  const key = PRICE_FIELD_BY_CODE[code] as keyof typeof peiwan;
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

function hasSend(channel: unknown): channel is TextBasedChannel & { send: Function } {
  return !!channel && typeof (channel as any).send === 'function';
}

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
  const channel = await safeFetchChannel(client, anonNotifyChannelId, 'anon log channel');
  if (channel && channel.isTextBased() && hasSend(channel)) {
    await safeSend(
      () => channel.send({ content, allowedMentions: { parse: ['users'] } }),
      'anon log'
    );
  }
}

async function getAnonGuild(message: Message): Promise<Guild | null> {
  if (cachedAnonGuild) return cachedAnonGuild;
  if (!orderAnonChannelId) return null;
  const channel = await safeFetchChannel(message.client, orderAnonChannelId, 'anon order channel');
  if (channel && channel.isTextBased() && 'guild' in channel && channel.guild) {
    cachedAnonGuild = channel.guild;
    return cachedAnonGuild;
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[messageCreate:endOrder] endOrder error:', err);
    if (msg?.includes('Order not running')) {
      const latest = await prisma.order.findUnique({
        where: { id: order.id },
        select: { status: true },
      });
      if (latest?.status === OrderStatus.ENDED) {
        await message.reply(`订单 ${orderLabel} 已结单。`);
        return true;
      }
    }
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
      chargedMinutes: true,
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
  const chargedMinutes = ended.chargedMinutes ?? 0;
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
  const pointsRow = await prisma.loyaltyPoint.findUnique({
    where: { discordUserId: ended.hostId },
    select: { points: true },
  });
  const pointsTotal = pointsRow ? Number(pointsRow.points.toString()) : 0;
  const pointsEarned = Math.max(0, gross);

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
          chargedMinutes,
          gross,
          hostBalance,
          heartInc,
          currentHeart,
          pointsEarned,
          pointsTotal
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
          chargedMinutes,
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
  const { channelIds: exclusiveChannelIds } = await getOrderChannelBindingSnapshot();
  const orderBroadcastChannelIds = Array.from(
    new Set([...configuredBroadcastChannelIds, ...exclusiveChannelIds, GENERAL_BROADCAST_CHANNEL_ID]),
  );
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
    const orderContentRaw = content.replace(/^!点单\s+\S+\s*/, '').trim();
    const orderContent = stripRoleMentions(orderContentRaw).slice(0, 1024);

    const peiwan = await prisma.pEIWAN.findUnique({
      where: { PEIWANID: peiwanIdNum },
      select: {
        PEIWANID: true,
        discordUserId: true,
        defaultQuotationCode: true,
        quotation_Q1: true,
        lolPrice: true,
        valPrice: true,
        deltaPrice: true,
        csgoPrice: true,
        narakaPrice: true,
        apexPrice: true,
        owPrice: true,
        tftPrice: true,
        steamPrice: true,
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
    const hostDisplayName = message.member?.displayName ?? null;
    updateMemberServerDisplayName(prisma, message.author.id, hostDisplayName).catch(() => {});

    const hostBalance = Number(hostMember.totalBalance.toString());
    if (!Number.isFinite(hostBalance) || hostBalance < 100) {
      const staffPing = '<@1421651539247894549>';
      const notice = `余额不足 100，点单失败。请先充值后再试，可联系 ${staffPing} 获取帮助。`;
      try {
        await message.author.send(notice);
      } catch {
        await message.reply('请查看私信');
      }
      return true;
    }

    const prices: Partial<Record<QuotationCode, number | null>> = {};
    for (const code of Object.keys(PRICE_FIELD_BY_CODE) as Array<QuotationCode>) {
      prices[code] = priceFromPeiwan(peiwan, code);
    }
    const orderId = message.id; // use message ID to correlate with price select interactions
    const priceSelect = buildQuotationSelect(
      mode === OrderMode.REALNAME ? 'REALNAME' : 'ANON',
      prices,
      orderId
    );
    if (!priceSelect) {
      await message.reply('该陪玩暂未配置可用价格，请联系工作人员。');
      return true;
    }

    const embed = new EmbedBuilder()
      .setTitle('请选择价格档位')
      .setColor(DEFAULT_EMBED_COLOR)
      .setDescription('选择价格后，机器人会向陪玩发送邀请。')
      .addFields({
        name: '陪玩ID',
        value: `${peiwan.PEIWANID}${peiwan.discordUserId ? ` ${userMention(peiwan.discordUserId)}` : ''}`.trim(),
        inline: true,
      })
      .addFields({
        name: '点单模式',
        value: mode === OrderMode.REALNAME ? '实名点单' : '匿名点单',
        inline: true,
      });

    if (orderContent) {
      embed.addFields({ name: '订单内容', value: orderContent, inline: false });
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(priceSelect);
    const payload = {
      content: '请选择价格后下单：',
      embeds: [embed],
      components: [row],
      allowedMentions: { parse: [] },
    };

    if (message.guild) {
      try {
        await message.author.send(payload);
        await message.reply({
          content: '邀请成功！请查看机器人私信',
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.error('[quickOrder] DM price select failed:', err);
        await message.reply('无法发送私信，请开启机器人私信后再试。');
      }
    } else {
      await message.reply(payload);
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
      const isBusy = err?.message?.includes?.('陪玩繁忙');
      if (isBusy) {
        const canceled = await prisma.order.updateMany({
          where: { id: order.id, status: OrderStatus.PENDING },
          data: { status: OrderStatus.CANCELED, endedAt: new Date() },
        });
        if (canceled.count > 0 && order.hostId) {
          const bossMsg = `陪玩 <@${order.workerId}> 正在忙，无法接单。可以邀请其他陪玩进行游玩哦～`;
          try {
            const bossUser = await message.client.users.fetch(order.hostId);
            await bossUser.send(bossMsg);
          } catch (notifyErr) {
            console.error('[inviteResponse] notify boss busy failed', notifyErr);
          }
        }
      }
      const msg =
        isBusy
          ? '您已经接单，不可重复接单。'
          : err?.message === 'ORDER_ALREADY_RUNNING'
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

  if (await handleRenameCardCommand(message)) return;
  if (await handleLotteryMessage(message)) return;
  if (await tryHandleEndOrderCommand(message)) return;
  if (await tryHandleInviteResponseCommand(message)) return;
  if (await tryHandleQuickOrderCommand(message)) return;

  if (!orderAnonChannelId) return;

  const hasAllowedRole = await messageMentionsAllowedRole(message);
  const { ownerMap: exclusiveOwnerMap, channelIds: exclusiveChannelIds } =
    await getOrderChannelBindingSnapshot();
  const orderBroadcastChannelIds = Array.from(
    new Set([...configuredBroadcastChannelIds, ...exclusiveChannelIds, GENERAL_BROADCAST_CHANNEL_ID]),
  );

  // 专属派单区：仅允许指定老板发单
    if (message.guild && exclusiveOwnerMap[message.channel.id]) {
      const expectedOwnerId = exclusiveOwnerMap[message.channel.id];
      if (userA.id !== expectedOwnerId) {
        return;
      }
  }

  const originalMsg = content;
  const orderId = message.id;       // 用消息 ID 作为 orderId
  const ownerId = userA.id;         // 🔴 显式传给按钮
  clickStore.init(orderId, ownerId);
  const defaultCallEmoji = '<:11:1422321930043789343>';
  const activities = await getActiveActivities();

  try {
    if (
      orderBroadcastChannelIds.includes(message.channel.id) &&
      hasAllowedRole
    ) {
      const ownerDisplayName = message.member?.displayName ?? null;
      updateMemberServerDisplayName(prisma, ownerId, ownerDisplayName).catch(() => {});
      recordOrderRequest({
        orderId,
        ownerId,
        content: originalMsg,
        ownerDisplayName,
      }).catch(() => {});
        const callEmoji =
          message.guild?.emojis.resolve('1422321930043789343')?.toString()
          ?? defaultCallEmoji;
        const embedResponse = ongoing_order_request_embed(
          userA.tag, content, originalMsg, orderId, ownerId, callEmoji, activities
        );
        if (message.channel instanceof TextChannel || message.channel instanceof DMChannel) {
          const hintMsg = await message.channel.send('老板派单啦，快来抢单');
          clickStore.registerMessage(orderId, hintMsg.id, hintMsg.channelId, ownerId, 'hint');
          const posted = await message.channel.send(embedResponse);
          clickStore.registerMessage(orderId, posted.id, posted.channelId, ownerId, 'body');
        scheduleOrderRequestClosure(posted);
      }

      // 专属派单区同步到综合派单区
      if (
        GENERAL_BROADCAST_CHANNEL_ID &&
        message.guild &&
        exclusiveOwnerMap[message.channel.id] &&
        message.channel.id !== GENERAL_BROADCAST_CHANNEL_ID
      ) {
        const generalChannel = await message.client.channels
          .fetch(GENERAL_BROADCAST_CHANNEL_ID)
          .catch(() => null);
        if (generalChannel instanceof TextChannel) {
          const hintGeneral = await generalChannel.send('老板派单啦，快来抢单');
          clickStore.registerMessage(orderId, hintGeneral.id, hintGeneral.channelId, ownerId, 'hint');
          const postedCopy = await generalChannel.send(embedResponse);
          clickStore.registerMessage(orderId, postedCopy.id, postedCopy.channelId, ownerId, 'body');
          scheduleOrderRequestClosure(postedCopy);
        }
      }

      const { embed: successEmbed, components: successComponents } = order_request_sent_successfully_embed(
        message.id,
        ownerId,
        activities,
      );
      await userA.send({ content: '订单创建成功！', embeds: [successEmbed], components: successComponents });
    } else if (!message.guild) {
      if (hasAllowedRole) {
        const ownerDisplayName = message.member?.displayName ?? null;
        updateMemberServerDisplayName(prisma, ownerId, ownerDisplayName).catch(() => {});
        recordOrderRequest({
          orderId,
          ownerId,
          content: originalMsg,
          ownerDisplayName,
        }).catch(() => {});
          const channelB = await safeFetchChannel(message.client, orderAnonChannelId, 'anon order channel');
          if (channelB instanceof TextChannel) {
            const callEmoji =
              channelB.guild?.emojis.resolve('1422321930043789343')?.toString()
            ?? defaultCallEmoji;
          const roleInfo = parseRoleMentions(content);
          if (roleInfo.mentionText) {
            await channelB.send({
              content: roleInfo.mentionText,
              allowedMentions: { users: [], roles: roleInfo.roleIds, parse: [] },
            });
          }
          const anonHint = await channelB.send('老板派单啦，快来抢单');
          clickStore.registerMessage(orderId, anonHint.id, anonHint.channelId, ownerId, 'hint');
          const embedResponse = anonymous_ongoing_order_request_embed(
            content, content, orderId, ownerId, callEmoji, activities
          );
          const posted = await channelB.send(embedResponse);
          clickStore.registerMessage(orderId, posted.id, posted.channelId, ownerId, 'body');
          scheduleOrderRequestClosure(posted);
        }

        const { embed: successEmbed, components: successComponents } = order_request_sent_successfully_embed(
          message.id,
          ownerId,
          activities,
        );
        await userA.send({ content: '订单创建成功！', embeds: [successEmbed], components: successComponents });

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

