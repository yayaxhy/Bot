import { EmbedBuilder, Message } from 'discord.js';
import { LotteryPool } from '@prisma/client';
import { DRAW_COST, LotteryError, POOL_LABEL, PRIZE_NAMES, performLotteryDraw } from '../services/lotteryService.js';
import { getScratchCodePrefix } from '../services/scratchService.js';

const LOTTERY_CMD_PATTERN = /^!抽奖(?:\s+<@!?(\d+)>)?$/;
const LOTTERY_REVEAL_DELAY_MS = 3000; // 动画结束后再揭晓，毫秒
const LOTTERY_ANIMATIONS: Record<LotteryPool, string | undefined> = {
  NORMAL:
    process.env.LOTTERY_ANIM_NORMAL
    ?? 'https://cdn.discordapp.com/attachments/1446831159047622769/1447697925017960529/704265bceb4a6631.gif?ex=6939e2c2&is=69389142&hm=509acaf8eccf2063a41022b3e3f2cbf2a537ff34fc344d41dd9bcacbaa2a3166&',
  MEDIUM:
    process.env.LOTTERY_ANIM_MEDIUM
    ?? 'https://cdn.discordapp.com/attachments/1446831159047622769/1447697948128575610/e26459feaa8dc614.gif?ex=6939e2c7&is=69389147&hm=4a53f56ec42ef9765a86b6adc639add0928490f273eccf7c38d79a391fb388cf&',
  ADVANCED:
    process.env.LOTTERY_ANIM_ADVANCED
    ?? 'https://cdn.discordapp.com/attachments/1446831159047622769/1447697968772939997/750bc09ff411119b.gif?ex=6939e2cc&is=6938914c&hm=bcd390e765ea72a976db86da0c7df1f9a899ad45ca97ad689be13e08bcc0c410&',
  SPECIAL:
    process.env.LOTTERY_ANIM_SPECIAL
    ?? 'https://cdn.discordapp.com/attachments/1446831159047622769/1447697999982629095/969955dd49e66858.gif?ex=6939e2d4&is=69389154&hm=1002840cffe7547227d6609852fb7cd25fb5b5f84e75739aba4d2dbc036960b7&',
};
const LOTTERY_COLORS: Record<LotteryPool, number> = {
  NORMAL: 0xc0c0c0,
  MEDIUM: 0xffd700,
  ADVANCED: 0x7b68ee,
  SPECIAL: 0xff4500,
};
const MYSTERY_CODE_PRIZE_NAME = '神秘代码';
const buildMysteryCodeDmMessage = () => {
  const prefix = getScratchCodePrefix();
  return `刮刮乐150金额的号码在${prefix}600到${prefix}700之间有一张`;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleLotteryMessage(message: Message): Promise<boolean> {
  const content = (message.content ?? '').trim();
  const match = content.match(LOTTERY_CMD_PATTERN);
  if (!match) {
    if (content.startsWith('!抽奖')) {
      await message.reply('用法：`!抽奖` 或 `!抽奖 @用户`');
      return true;
    }
    return false;
  }

  const payerId = message.author.id;
  const userId = match[1] ?? payerId;
  const isGiftDraw = userId !== payerId;
  const targetMention = `<@${userId}>`;
  const nonce = `msg:${message.id}`;
  const costLabel = Number(DRAW_COST.toString()).toFixed(0);

  let result;
  try {
    result = await performLotteryDraw({ userId, payerId, nonce, requestId: message.id });
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
  const drawingText = isGiftDraw
    ? `已扣除 ¥${costLabel}，正在为 ${targetMention} 抽奖...`
    : `已扣除 ¥${costLabel}，抽奖中...`;

  const startEmbed = new EmbedBuilder()
    .setTitle('开始抽奖！')
    .setDescription(drawingText);
  if (poolColor) startEmbed.setColor(poolColor);
  if (animationUrl) startEmbed.setImage(animationUrl);

  const sent = await message.reply({
    content: drawingText,
    embeds: [startEmbed],
  });

  await wait(LOTTERY_REVEAL_DELAY_MS);

  const revealLines =
    prize.name === MYSTERY_CODE_PRIZE_NAME
      ? [
          isGiftDraw
            ? `恭喜${targetMention}抽到了对应颜色礼物：神秘代码`
            : '恭喜您抽到了对应颜色礼物：神秘代码',
          '请查看机器人私信噢',
        ]
      : [
          isGiftDraw
            ? `恭喜${targetMention}抽到了${poolLabel}礼物：${prize.name}`
            : `恭喜您抽到了${poolLabel}礼物：${prize.name}`,
        ];
  if (prize.name === PRIZE_NAMES.BLOCK_STACK_VOUCHER) {
    revealLines.push('使用方法：输入!抽积木消耗该代金券');
  }

  const revealEmbed = new EmbedBuilder()
    .setTitle('开始抽奖！')
    .setDescription(revealLines.join('\n'));
  if (poolColor) revealEmbed.setColor(poolColor);
  const prizeImage = prize.imageUrl ?? animationUrl;
  if (prizeImage) revealEmbed.setImage(prizeImage);

  try {
    await sent.edit({ content: '抽奖结束！', embeds: [revealEmbed] });
  } catch (err) {
    console.error('[lottery] reveal edit failed:', err);
  }

  if (prize.name === MYSTERY_CODE_PRIZE_NAME) {
    try {
      const targetUser =
        isGiftDraw
          ? await message.client.users.fetch(userId).catch(() => null)
          : message.author;
      if (targetUser) {
        await targetUser.send({ content: buildMysteryCodeDmMessage() });
      }
    } catch (err) {
      console.error('[lottery] mystery-code DM failed:', {
        userId,
        err,
      });
    }
  }

  return true;
}
