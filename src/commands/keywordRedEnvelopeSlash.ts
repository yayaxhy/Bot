import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  bindPendingEnvelopeMessage,
  createRedEnvelope,
  expireEnvelope,
  scheduleRedEnvelopeExpiration,
  sendKeywordAuditMessage,
  rememberKeywordEnvelope,
  getKeywordValidationError,
} from '../services/redEnvelopeService.js';
import prisma from '../db/prisma.js';

const DEC = (v: number | string | Prisma.Decimal) =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);

const MIN_TOTAL = DEC('10');
const DEFAULT_NOTE = '发送口令即可抢红包，拼手气领赏！';

async function notifyKeywordInvalidSlash(i: ChatInputCommandInteraction, reason: string) {
  const content = `口令红包发送失败：${reason}`;
  try {
    await i.user.send(content);
    return;
  } catch {}
  await i.reply({ content, ephemeral: true });
}

export const keywordRedEnvelopeSlashCommand = new SlashCommandBuilder()
  .setName('口令红包')
  .setDescription('发一个口令红包')
  .addStringOption((option) =>
    option
      .setName('口令')
      .setDescription('自定义口令，用户发送该口令即可抢红包')
      .setRequired(true)
  )
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
      .setDescription('红包总金额，至少 ¥10')
      .setRequired(true)
      .setMinValue(10)
  )
  .addStringOption((option) =>
    option
      .setName('留言')
      .setDescription('可选祝福语，展示在红包上')
      .setRequired(false)
  );

export async function handleKeywordRedEnvelopeSlash(
  i: ChatInputCommandInteraction,
  client: PrismaClient = prisma
) {
  if (i.commandName !== '口令红包') return;

  if (!i.guild) {
    await i.reply({ content: '请在服务器频道里发红包哦。', ephemeral: true });
    return;
  }

  const keyword = i.options.getString('口令', true).trim();
  const count = i.options.getInteger('份数', true);
  const amountNumber = i.options.getNumber('总额', true);
  const note = i.options.getString('留言')?.trim();
  const amount = DEC(amountNumber.toFixed(2));

  const keywordError = getKeywordValidationError(keyword);
  if (keywordError) {
    await notifyKeywordInvalidSlash(i, keywordError);
    return;
  }
  if (count > 100) {
    await i.reply({ content: '红包份数不能超过 100 份。', ephemeral: true });
    return;
  }
  if (amount.lt(MIN_TOTAL)) {
    await i.reply({ content: '红包总金额至少 ¥10。', ephemeral: true });
    return;
  }

  await i.deferReply({ ephemeral: false });

  try {
    const envelope = await createRedEnvelope(
      {
        creatorId: i.user.id,
        totalAmount: amount,
        count,
        note: note || DEFAULT_NOTE,
        channelId: i.channelId,
        kind: 'keyword',
        keyword,
      },
      client
    );

    const channel: any = i.channel;
    if (!channel || typeof channel.send !== 'function') {
      await expireEnvelope(envelope.id, client);
      await i.editReply('当前频道不支持发送红包。');
      return;
    }
    const pendingMessage = await channel.send('红包正在审核中~ 请稍等');

    scheduleRedEnvelopeExpiration((globalThis as any).__CLIENT__, {
      id: envelope.id,
      expiresAt: envelope.expiresAt,
    });
    await bindPendingEnvelopeMessage(
      envelope.id,
      { pendingMessageId: pendingMessage.id, channelId: channel.id },
      client
    );

    rememberKeywordEnvelope(
      {
        id: envelope.id,
        keyword,
        note: envelope.note,
        channelId: channel.id,
        pendingMessageId: pendingMessage.id,
        pendingChannelId: channel.id,
      },
      'pending'
    );

    await sendKeywordAuditMessage((globalThis as any).__CLIENT__ ?? i.client, {
      envelopeId: envelope.id,
      creatorId: i.user.id,
      keyword,
      channelId: channel.id,
    });

    try { await i.deleteReply(); } catch {}
  } catch (err: any) {
    console.error('[keyword-red-envelope slash] create failed:', err);
    const message = err?.message ?? '创建口令红包失败，请稍后再试。';
    try {
      await i.editReply(`无法发红包：${message}`);
    } catch {}
  }
}
