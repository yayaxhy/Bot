import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  bindEnvelopeMessage,
  buildRedEnvelopeMessagePayload,
  createRedEnvelope,
  expireEnvelope,
  scheduleRedEnvelopeExpiration,
  CLAIM_EMOJI_REACTION,
} from '../services/redEnvelopeService.js';
import prisma from '../db/prisma.js';

const DEC = (v: number | string | Prisma.Decimal) =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);

const MIN_TOTAL = DEC('1');
const DEFAULT_NOTE = '锦鲤附体，好运暴击！';

export const redEnvelopeSlashCommand = new SlashCommandBuilder()
  .setName('红包')
  .setDescription('发一个拼手气红包')
  .addIntegerOption((option) =>
    option
      .setName('份数')
      .setDescription('红包份数，1-100')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100)
  )
  .addNumberOption((option) =>
    option
      .setName('总额')
      .setDescription('红包总金额，至少 ¥1')
      .setRequired(true)
      .setMinValue(1)
  )
  .addStringOption((option) =>
    option
      .setName('留言')
      .setDescription('可选祝福语，展示在红包上（默认为：锦鲤附体，好运暴击！）')
      .setRequired(false)
  );

const sanitizeName = (name?: string | null) => {
  if (!name) return undefined;
  const cleaned = name.replace(/<@!?\d+>/g, '').trim();
  return cleaned || undefined;
};

export async function handleRedEnvelopeSlash(
  i: ChatInputCommandInteraction,
  client: PrismaClient = prisma
) {
  if (i.commandName !== '红包') return;

  if (!i.guild) {
    await i.reply({ content: '请在服务器频道里发红包哦。', ephemeral: true });
    return;
  }

  const count = i.options.getInteger('份数', true);
  const amountNumber = i.options.getNumber('总额', true);
  const note = i.options.getString('留言')?.trim();
  const amount = DEC(amountNumber.toFixed(2));

  if (count > 100) {
    await i.reply({ content: '红包份数不能超过 100 份。', ephemeral: true });
    return;
  }
  if (amount.lt(MIN_TOTAL)) {
    await i.reply({ content: '红包总金额至少 ¥1。', ephemeral: true });
    return;
  }

  await i.deferReply({ ephemeral: true });

  try {
    const envelope = await createRedEnvelope(
      {
        creatorId: i.user.id,
        totalAmount: amount,
        count,
        note: note || DEFAULT_NOTE,
        channelId: i.channelId,
      },
      client
    );

    const channel: any = i.channel;
    if (!channel || typeof channel.send !== 'function') {
      await expireEnvelope(envelope.id, client);
      await i.editReply('当前频道不支持发送红包。');
      return;
    }

    const creatorDisplayName =
      sanitizeName((i.member as any)?.displayName) ?? sanitizeName(i.user.username);
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
      client
    );

    try {
      await sent.react(CLAIM_EMOJI_REACTION);
    } catch (reactErr) {
      console.error('[red-envelope slash] add reaction failed:', reactErr);
    }

    try {
      await sent.edit({ ...payload, content: '', allowedMentions: { parse: [] } });
    } catch (pingErr) {
      console.error('[red-envelope slash] here clear failed:', pingErr);
    }

    scheduleRedEnvelopeExpiration((globalThis as any).__CLIENT__, {
      id: envelope.id,
      expiresAt: envelope.expiresAt,
    });

    await i.editReply('红包已发出，大家快来抢！');
  } catch (err: any) {
    console.error('[red-envelope slash] create failed:', err);
    const message = err?.message ?? '创建红包失败，请稍后再试。';
    try {
      await i.editReply(`无法发红包：${message}`);
    } catch {}
  }
}
