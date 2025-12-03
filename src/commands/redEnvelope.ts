import { Client, Message } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  bindEnvelopeMessage,
  buildRedEnvelopeMessagePayload,
  createRedEnvelope,
  expireEnvelope,
  scheduleRedEnvelopeExpiration,
  CLAIM_EMOJI_REACTION,
} from '../services/redEnvelopeService.js';

const DEC = (v: number | string | Prisma.Decimal) =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);

const DEFAULT_NOTE = '锦鲤附体，好运暴击！';

const sanitizeName = (name?: string | null) => {
  if (!name) return undefined;
  const cleaned = name.replace(/<@!?\d+>/g, '').trim();
  return cleaned || undefined;
};

type ParsedCommand = {
  count: number;
  amount: Prisma.Decimal;
  note?: string;
};

function parseRedEnvelopeCommand(content: string): ParsedCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('!红包')) return null;

  const rest = trimmed.slice('!红包'.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/);
  if (parts.length < 1) return null;

  const [firstToken, ...noteParts] = parts;
  if (!firstToken.includes('/')) return null;

  const [countRaw, amountRaw] = firstToken.split('/');
  const countMatch = countRaw.match(/^(\d+)\s*个$/);
  const amountMatch = amountRaw.match(/^(\d+(?:\.\d{1,2})?)\s*元$/);
  if (!countMatch || !amountMatch) return null;
  const count = Number(countMatch[1]);
  const amount = Number(amountMatch[1]);
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const note = noteParts.join(' ').trim();

  return {
    count,
    amount: DEC(amount.toFixed(2)),
    note: note || undefined,
  };
}

export function registerRedEnvelopeCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg: Message) => {
    try {
      if (msg.author.bot) return;

      const parsed = parseRedEnvelopeCommand(msg.content);
      if (!parsed) return;

      if (!msg.guild) {
        await msg.reply('请在服务器频道里发红包哦。');
        return;
      }

      const minTotal = DEC('1');
      if (parsed.amount.lt(minTotal)) {
        await msg.reply('红包总金额至少 ¥1。');
        return;
      }

      if (parsed.count > 100) {
        await msg.reply('红包份数不能超过 100 份。');
        return;
      }

      const envelope = await createRedEnvelope(
        {
          creatorId: msg.author.id,
          totalAmount: parsed.amount,
          count: parsed.count,
          note: parsed.note ?? DEFAULT_NOTE,
          channelId: msg.channel.id,
        },
        prisma
      );

      const channel: any = msg.channel;
      if (!channel || typeof channel.send !== 'function') {
        await expireEnvelope(envelope.id, prisma);
        await msg.reply('当前频道不支持发送红包。');
        return;
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
          prisma
        );

        try {
          await sent.react(CLAIM_EMOJI_REACTION);
        } catch (reactErr) {
          console.error('[red-envelope] add reaction failed:', reactErr);
        }

        try {
          await sent.edit({ ...payload, content: '', allowedMentions: { parse: [] } });
        } catch (pingErr) {
          console.error('[red-envelope] here clear failed:', pingErr);
        }

        scheduleRedEnvelopeExpiration(client, {
          id: envelope.id,
          expiresAt: envelope.expiresAt,
        });
      } catch (sendErr) {
        await expireEnvelope(envelope.id, prisma);
        throw sendErr;
      }
    } catch (err: any) {
      console.error('[red-envelope] create failed:', err);
      const message = err?.message ?? '创建红包失败，请稍后再试。';
      try {
        await msg.reply(`无法发红包：${message}`);
      } catch {}
    }
  });
}
