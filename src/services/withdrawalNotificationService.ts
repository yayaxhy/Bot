import { EmbedBuilder, type Client } from 'discord.js';
import prisma from '../db/prisma.js';

export interface WithdrawalNotificationPayload {
  userDiscordId: string;
  amount: number | string;
  requestedAt?: string | number | Date;
  withdrawalId?: string;
  note?: string;
  currency?: string;
  remainingIncome?: number | string;
  workId?: number;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
};

const DEFAULT_CURRENCY = process.env.WITHDRAWAL_CURRENCY ?? 'CNY';
const DEFAULT_TIMEZONE = process.env.WITHDRAWAL_TIMEZONE ?? 'Asia/Shanghai';

let formatter: Intl.DateTimeFormat;
try {
  formatter = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DEFAULT_TIMEZONE,
  });
} catch (err) {
  console.warn('[withdraw.notify] invalid timezone, falling back to default locale formatter', {
    DEFAULT_TIMEZONE,
    err,
  });
  formatter = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function ensureNumber(value: number | string | undefined | null): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatCurrency(value: number | string | undefined, currency?: string): string {
  const amount = ensureNumber(value);
  if (amount == null) {
    return '未知金额';
  }
  const code = (currency ?? DEFAULT_CURRENCY).toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const suffix = symbol ? '' : ` ${code}`;
  return `${symbol ?? ''}${amount.toFixed(2)}${suffix}`.trim();
}

function formatDate(date: Date): string {
  return formatter.format(date);
}

export async function notifyWithdrawal(payload: WithdrawalNotificationPayload) {
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) {
    console.warn('[withdraw.notify] missing client instance', payload);
    return;
  }

  const { userDiscordId } = payload;
  const amountNumber = ensureNumber(payload.amount);

  if (!userDiscordId || !amountNumber || amountNumber <= 0) {
    console.warn('[withdraw.notify] invalid payload', payload);
    return;
  }

  let requestedAt = payload.requestedAt ? new Date(payload.requestedAt) : new Date();
  if (Number.isNaN(requestedAt.getTime())) {
    requestedAt = new Date();
  }

  const currency = (payload.currency ?? DEFAULT_CURRENCY).toUpperCase();

  let latestIncome: number | undefined;
  try {
    const member = await prisma.member.findUnique({
      where: { discordUserId: userDiscordId },
       select: { income: true, peiwan: { select: { PEIWANID: true } } },
    });
    if (member?.income) {
      latestIncome = Number(member.income.toString());
    }
    if (member?.peiwan?.PEIWANID != null) {
      payload.workId = member.peiwan.PEIWANID;
    }
  } catch (err) {
    console.error('[withdraw.notify] failed to load member income', { userDiscordId, err });
  }

  const remainingIncome =
    ensureNumber(payload.remainingIncome) ?? (latestIncome != null ? Number(latestIncome) : undefined);

  const lines = [
    `你在 ${formatDate(requestedAt)} 发起了提现 ${formatCurrency(amountNumber, currency)}。`,
  ];
  if (payload.withdrawalId) {
    lines.push(`订单号：${payload.withdrawalId}`);
  }

  if (payload.note) {
    lines.push(`提现方式：${payload.note}`);
  }

  const embed = new EmbedBuilder()
    .setTitle('提现通知')
    .setDescription(lines.join('\n'))
    .setColor(0xf4a460);

  try {
    const user = await client.users.fetch(userDiscordId);
    await user.send({ embeds: [embed] });
    console.log('[withdraw.notify] sent DM', {
      userDiscordId,
      withdrawalId: payload.withdrawalId,
    });
  } catch (err) {
    console.error('[withdraw.notify] failed to send DM', { userDiscordId, err });
  }

  const announceChannelId = process.env.WITHDRAW_ANNOUNCE_CHANNEL_ID;
  if (announceChannelId) {
    try {
      const channel = await client.channels.fetch(announceChannelId);
      if (channel && 'send' in channel && typeof (channel as any).send === 'function') {
        const mention = `<@${userDiscordId}>`;
        const workIdLine = payload.workId != null ? `陪玩ID：${payload.workId}` : null;
        const lines = [
          `${mention} 在 ${formatDate(requestedAt)} 发起了提现`,
          `金额：${formatCurrency(amountNumber, currency)}。`,
        ];
        if (payload.withdrawalId) {
          lines.push(`订单号：${payload.withdrawalId}`);
        }
        lines.push(`提现方式：${payload.note ?? '—'}`);
         if (workIdLine) {
          lines.splice(1, 0, workIdLine);
        }
        const announceEmbed = new EmbedBuilder()
          .setTitle('提现公告')
          .setDescription(lines.join('\n'))
          .setColor(0xf4a460);
          
        await (channel as any).send({ embeds: [announceEmbed] });
      } else {
        console.warn('[withdraw.notify] announce channel not text based', { announceChannelId });
      }
    } catch (err) {
      console.error('[withdraw.notify] failed to send announce message', { announceChannelId, err });
    }
  }
}
