import { EmbedBuilder, Message } from 'discord.js';
import { LotteryPool } from '@prisma/client';
import { DRAW_COST, LotteryError, POOL_LABEL, performLotteryDraw } from '../services/lotteryService.js';

const LOTTERY_CMD_PATTERN = /^!抽奖$/;
const LOTTERY_REVEAL_DELAY_MS = 4500; // 动画结束后再揭晓，毫秒
const LOTTERY_ANIMATIONS: Record<LotteryPool, string | undefined> = {
  NORMAL: process.env.LOTTERY_ANIM_NORMAL,
  MEDIUM: process.env.LOTTERY_ANIM_MEDIUM,
  ADVANCED: process.env.LOTTERY_ANIM_ADVANCED,
  SPECIAL: process.env.LOTTERY_ANIM_SPECIAL,
};
const LOTTERY_COLORS: Record<LotteryPool, number> = {
  NORMAL: 0xc0c0c0,
  MEDIUM: 0xffd700,
  ADVANCED: 0x7b68ee,
  SPECIAL: 0xff4500,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleLotteryMessage(message: Message): Promise<boolean> {
  const content = (message.content ?? '').trim();
  if (!LOTTERY_CMD_PATTERN.test(content)) return false;

  const userId = message.author.id;
  const nonce = `msg:${message.id}`;
  const costLabel = Number(DRAW_COST.toString()).toFixed(0);

  let result;
  try {
    result = await performLotteryDraw({ userId, nonce, requestId: message.id });
  } catch (err: any) {
    if (err instanceof LotteryError) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        await message.reply(`余额不足 ${costLabel} 元，无法抽奖。`);
        return true;
      }
      if (err.code === 'NO_PRIZE_AVAILABLE' || err.code === 'NO_FALLBACK_PRIZE') {
        await message.reply('奖池暂不可用，请稍后再试。');
        return true;
      }
    }
    console.error('[lottery] draw failed:', err);
    await message.reply('抽奖失败，请稍后重试。');
    return true;
  }

  const { prize, pool } = result;
  const poolLabel = POOL_LABEL[pool] ?? pool;
  const animationUrl = prize.animationUrl ?? LOTTERY_ANIMATIONS[pool];
  const poolColor = LOTTERY_COLORS[pool] ?? undefined;

  const startEmbed = new EmbedBuilder()
    .setTitle('开始抽奖！')
    .setDescription(`已扣除 ¥${costLabel}，抽奖动画播放中...`)
    .setFooter({ text: `奖池：${poolLabel}` });
  if (poolColor) startEmbed.setColor(poolColor);
  if (animationUrl) startEmbed.setImage(animationUrl);

  const sent = await message.reply({ embeds: [startEmbed] });

  await wait(LOTTERY_REVEAL_DELAY_MS);

  const revealEmbed = new EmbedBuilder()
    .setTitle('开始抽奖！')
    .setDescription(`恭喜您抽到了${poolLabel}礼物：${prize.name}`);
  if (poolColor) revealEmbed.setColor(poolColor);
  const prizeImage = prize.imageUrl ?? animationUrl;
  if (prizeImage) revealEmbed.setImage(prizeImage);

  try {
    await sent.edit({ embeds: [revealEmbed] });
  } catch (err) {
    console.error('[lottery] reveal edit failed:', err);
  }

  return true;
}
