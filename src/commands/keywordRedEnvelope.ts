import { Client, Message } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  bindEnvelopeMessage,
  buildRedEnvelopeMessagePayload,
  createRedEnvelope,
  expireEnvelope,
  scheduleRedEnvelopeExpiration,
} from '../services/redEnvelopeService.js';

const DEC = (v: number | string | Prisma.Decimal) =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);

const DEFAULT_NOTE = '发送口令即可抢红包，拼手气领赏！';
const MIN_TOTAL = DEC('10');

const sanitizeName = (name?: string | null) => {
  if (!name) return undefined;
  const cleaned = name.replace(/<@!?\d+>/g, '').trim();
  return cleaned || undefined;
};

type ParsedKeywordEnvelope = {
  keyword: string;
  count: number;
  amount: Prisma.Decimal;
  note?: string;
};

function parseKeywordRedEnvelopeCommand(content: string): ParsedKeywordEnvelope | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('!口令红包')) return null;

  const rest = trimmed.slice('!口令红包'.length).trim();
  if (!rest) return null;

  const [rawKeyword, ...restParts] = rest.split(/\s+/);
  const keyword = rawKeyword?.trim();
  if (!keyword) return null;

  const remainder = restParts.join(' ').trim();
  if (!remainder) return null;

  const match = remainder.match(/^(\d+)\s*个\s*\/\s*(\d+(?:\.\d{1,2})?)\s*元?(?:\s+(.*))?$/);
  if (!match) return null;

  const count = Number(match[1]);
  const amountNumber = Number(match[2]);
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) return null;

  const note = match[3]?.trim();

  return {
    keyword,
    count,
    amount: DEC(amountNumber.toFixed(2)),
    note: note || undefined,
  };
}

export async function handleKeywordRedEnvelopeMessage(msg: Message, prismaClient: PrismaClient): Promise<boolean> {
  if (msg.author.bot) return false;

  const parsed = parseKeywordRedEnvelopeCommand(msg.content);
  if (!parsed) return false;

  if (!msg.guild) {
    await msg.reply('请在服务器频道里发红包哦。');
    return true;
  }

  if (!parsed.keyword.trim()) {
    await msg.reply('口令不能为空。');
    return true;
  }
  if (parsed.keyword.length > 50) {
    await msg.reply('口令长度不能超过 50 个字符。');
    return true;
  }
  if (/@everyone|@here/.test(parsed.keyword) || /<@&\d+>/.test(parsed.keyword)) {
    await msg.reply('口令不能包含 @everyone/@here 或角色提及。');
    return true;
  }
  if (parsed.amount.lt(MIN_TOTAL)) {
    await msg.reply('红包总金额至少 ¥10。');
    return true;
  }

  if (parsed.count > 100) {
    await msg.reply('红包份数不能超过 100 份。');
    return true;
  }

  const envelope = await createRedEnvelope(
    {
      creatorId: msg.author.id,
      totalAmount: parsed.amount,
      count: parsed.count,
      note: parsed.note ?? DEFAULT_NOTE,
      channelId: msg.channel.id,
      kind: 'keyword',
      keyword: parsed.keyword,
    },
    prismaClient
  );

  const channel: any = msg.channel;
  if (!channel || typeof channel.send !== 'function') {
    await expireEnvelope(envelope.id, prismaClient);
    await msg.reply('当前频道不支持发送红包。');
    return true;
  }

  try {
    const creatorDisplayName =
      sanitizeName(msg.member?.displayName) ?? sanitizeName(msg.author.username);
    const payload = buildRedEnvelopeMessagePayload({
      id: envelope.id,
      creatorId: envelope.creatorId,
      creatorDisplayName,
      totalAmount: envelope.totalAmount,
      totalCount: envelope.totalCount,
      remainingCount: envelope.remainingCount,
      status: envelope.status,
      expiresAt: envelope.expiresAt,
      note: envelope.note ?? undefined,
      refundedAmount: envelope.refundedAmount ?? undefined,
    });

    const sent = await channel.send({
      ...payload,
      content: '@here',
      allowedMentions: { parse: ['everyone'] },
    });
    await bindEnvelopeMessage(
      envelope.id,
      { messageId: sent.id, channelId: sent.channelId },
      prismaClient
    );

    try {
      await sent.edit({ ...payload, content: '', allowedMentions: { parse: [] } });
    } catch (pingErr) {
      console.error('[keyword-red-envelope] here clear failed:', pingErr);
    }

    scheduleRedEnvelopeExpiration(msg.client, {
      id: envelope.id,
      expiresAt: envelope.expiresAt,
    });
  } catch (sendErr) {
    await expireEnvelope(envelope.id, prismaClient);
    throw sendErr;
  }

  return true;
}

export function registerKeywordRedEnvelopeCommand(client: Client, prismaClient: PrismaClient) {
  client.on('messageCreate', async (msg: Message) => {
    try {
      await handleKeywordRedEnvelopeMessage(msg, prismaClient);
    } catch (err: any) {
      console.error('[keyword-red-envelope] create failed:', err);
      const message = err?.message ?? '创建口令红包失败，请稍后再试。';
      try {
        await msg.reply(`无法发口令红包：${message}`);
      } catch {}
    }
  });
}
