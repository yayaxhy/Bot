import { LotteryStatus } from '@prisma/client';
import { Message } from 'discord.js';
import prisma from '../db/prisma.js';
import { PRIZE_NAMES } from '../services/lotteryService.js';

const RENAME_NOTIFY_CHANNEL_ID = '1446819752692416542';
const RENAME_NOTIFY_USER_ID = '1421651539247894549';

export async function handleRenameCardCommand(message: Message): Promise<boolean> {
  const content = (message.content ?? '').trim();
  if (content !== '!使用改名卡' && content !== '!改名卡') return false;

  const userId = message.author.id;
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await tx.lotteryDraw.updateMany({
      where: {
        userId,
        status: LotteryStatus.UNUSED,
        expiresAt: { lte: now },
        prize: { name: PRIZE_NAMES.RENAME_CARD },
      },
      data: { status: LotteryStatus.EXPIRED },
    });

    const card = await tx.lotteryDraw.findFirst({
      where: {
        userId,
        status: LotteryStatus.UNUSED,
        expiresAt: { gt: now },
        prize: { name: PRIZE_NAMES.RENAME_CARD },
      },
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!card) return { used: false };

    await tx.lotteryDraw.update({
      where: { id: card.id },
      data: { status: LotteryStatus.USED, consumeAt: now },
    });
    return { used: true };
  });

  if (!result.used) {
    await message.reply('你没有可用的改名卡。');
    return true;
  }

  const notifyText = `老板 <@${userId}> 使用了改名卡，请联系老板。`;
  try {
    const channel = await message.client.channels.fetch(RENAME_NOTIFY_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as any).send({ content: notifyText, allowedMentions: { users: [userId] } });
    }
  } catch (err) {
    console.error('[rename-card] channel notify failed:', err);
  }

  try {
    const user = await message.client.users.fetch(RENAME_NOTIFY_USER_ID);
    await user.send({ content: notifyText, allowedMentions: { users: [userId] } });
  } catch (err) {
    console.error('[rename-card] dm notify failed:', err);
  }

  await message.reply('改名卡已使用，工作人员会尽快联系你。');
  return true;
}
