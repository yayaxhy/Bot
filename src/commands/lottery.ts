import { EmbedBuilder, Message } from 'discord.js';
import { LotteryPool } from '@prisma/client';
import { DRAW_COST, LotteryError, POOL_LABEL, performLotteryDraw } from '../services/lotteryService.js';

const LOTTERY_CMD_PATTERN = /^!抽奖$/;
const LOTTERY_REVEAL_DELAY_MS = 4500; // 动画结束后再揭晓，毫秒
const LOTTERY_ANIMATIONS: Record<LotteryPool, string | undefined> = {
  NORMAL:
    process.env.LOTTERY_ANIM_NORMAL
    ?? 'https://cdn.discordapp.com/attachments/1446831159047622769/1446831227465240689/18.gif?ex=69356a15&is=69341895&hm=06fb3f1b4f4c84db4d6f639a4fb9a187730bfd80c37456e4a600f95041550412&',
  MEDIUM:
    process.env.LOTTERY_ANIM_MEDIUM
    ?? 'https://cdn.discordapp.com/attachments/1446831159047622769/1446831200240013362/19.gif?ex=69356a0e&is=6934188e&hm=814fccdba9be13ac799939f69d684b00baa1e4a0c256474241d97e0b67589d1e&',
  ADVANCED:
    process.env.LOTTERY_ANIM_ADVANCED
    ?? 'https://cdn.discordapp.com/attachments/1446831159047622769/1446834078203641970/jimeng-2025-12-06-7864-....png?ex=69356cbd&is=69341b3d&hm=afbc06c209d672f4517659eb9afdc05c6a54c4ef72369d9f9e40667312be05c0&',
  SPECIAL:
    process.env.LOTTERY_ANIM_SPECIAL
    ?? 'https://cdn.discordapp.com/attachments/1436573568032047255/1436575507771555911/ff274cd0ede7f16b.gif?ex=693504b3&is=6933b333&hm=266f4004628420cd172ec5501f006b692cc91561ffdc890a76bcfe9a32b3cefb&',
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
  const animationUrl = LOTTERY_ANIMATIONS[pool];
  const poolColor = LOTTERY_COLORS[pool] ?? undefined;

  const startEmbed = new EmbedBuilder()
    .setTitle('已扣除，开始抽奖！')
    .setDescription(`已扣除 ¥${costLabel}，抽奖中...`)
    .setFooter({ text: `奖池：${poolLabel}` });
  if (poolColor) startEmbed.setColor(poolColor);
  if (animationUrl) startEmbed.setImage(animationUrl);

  const sent = await message.reply({
    content: `已扣除 ¥${costLabel}，抽奖中...`,
    embeds: [startEmbed],
  });

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
