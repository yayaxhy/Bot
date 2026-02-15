import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import prisma from '../db/prisma.js';
import { CouponStatus, CouponType, LotteryPool, LotteryStatus } from '@prisma/client';
import crypto from 'node:crypto';
import { isUniqueConstraintError, realignCouponSequence } from '../services/sequenceService.js';
import { isCashAdmin } from './cash.js';
import { PRIZE_NAMES } from '../services/lotteryService.js';

type GrantItem = {
  label: string;
  couponType?: CouponType;
  lotteryPrizeName?: string;
};

const GRANT_ITEMS: Record<string, GrantItem> = {
  DISCOUNT_90: { label: '9折券', couponType: CouponType.DISCOUNT_90 },
  LOTTERY_DISCOUNT_80: { label: '8折券', couponType: CouponType.DISCOUNT_80 },
  LOTTERY_DISCOUNT_70: { label: '7折券', couponType: CouponType.DISCOUNT_70 },
  LOTTERY_DISCOUNT_90: { label: '特殊9折券', couponType: CouponType.DISCOUNT_90_LOTTERY },
  CAKE: { label: '小蛋糕代金券', couponType: CouponType.CAKE_VOUCHER },
  LOLLIPOP: { label: '棒棒糖代金券', couponType: CouponType.LOLLIPOP_VOUCHER },
  PERFUME: { label: '香水代金券', couponType: CouponType.PERFUME_VOUCHER },
  CAROUSEL: { label: '旋转木马代金券', couponType: CouponType.CAROUSEL_VOUCHER },
  PUMPKIN_CAR: { label: '南瓜车代金券', couponType: CouponType.PUMPKIN_CAR_VOUCHER },
  PHONOGRAPH: { label: '留声机代金券', couponType: CouponType.PHONOGRAPH_VOUCHER },
  CROWN_75: { label: '一日冠75折券', couponType: CouponType.CROWN_75_VOUCHER },
  CROWN_DAY_90: { label: '一日冠9折券', couponType: CouponType.CROWN_DAY_90_VOUCHER },
  CROWN_3DAY_90: { label: '三日冠9折券', couponType: CouponType.CROWN_3DAY_90_VOUCHER },
  CROWN_WEEK_90: { label: '一周冠9折券', couponType: CouponType.CROWN_WEEK_90_VOUCHER },
  CROWN_MONTH_90: { label: '月冠名9折券', couponType: CouponType.CROWN_MONTH_90_VOUCHER },
  RENAME_CARD_3: { label: '3位数靓号卡', couponType: CouponType.RENAME_CARD_3 },
  RENAME_CARD_4: { label: '4位数靓号卡', couponType: CouponType.RENAME_CARD },
  RENAME_CARD_5: { label: '5位数靓号卡', couponType: CouponType.RENAME_CARD_5 },
  LOTTERY_VOUCHER: { label: '抽奖代金券', couponType: CouponType.LOTTERY_VOUCHER },
  CUSTOM_GIFT: { label: '自定义礼物券', couponType: CouponType.CUSTOM_GIFT_VOUCHER },
  CUSTOM_TAG: { label: '自定义tag券', couponType: CouponType.CUSTOM_TAG_VOUCHER },
  COMMISSION_MINUS1: { label: '抽成降1%券', couponType: CouponType.COMMISSION_MINUS1_VOUCHER },
  DOUBLE_FLOW_5000: { label: '双倍流水5000券', couponType: CouponType.DOUBLE_FLOW_5000_VOUCHER },
  DOUBLE_SPEND_5000: { label: '双倍消费5000券', couponType: CouponType.DOUBLE_SPEND_5000_VOUCHER },
  BLOCK_STACK_VOUCHER: { label: '积木游戏代金券', lotteryPrizeName: PRIZE_NAMES.BLOCK_STACK_VOUCHER },
};

const CHOICES = Object.entries(GRANT_ITEMS).map(([value, item]) => ({
  name: item.label,
  value,
}));

export const grantCouponCommand = new SlashCommandBuilder()
  .setName('送券')
  .setDescription('给指定用户发放优惠券')
  .addStringOption((option) =>
    option
      .setName('券种')
      .setDescription('选择要发放的优惠券类型')
      .setRequired(true)
      .addChoices(...CHOICES)
  )
  .addIntegerOption((option) =>
    option
      .setName('数量')
      .setDescription('要发放的张数')
      .setRequired(true)
      .setMinValue(1)
  )
  .addUserOption((option) =>
    option
      .setName('用户')
      .setDescription('要发券的用户')
      .setRequired(true)
  );

export async function handleGrantCouponSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '送券') return;

  if (!isCashAdmin(i)) {
    await i.reply({ content: '❌ 你没有权限使用该命令。', ephemeral: true });
    return;
  }

  const couponType = i.options.getString('券种', true);
  const quantity = i.options.getInteger('数量', true);
  const target = i.options.getUser('用户', true);

  if (!quantity || quantity <= 0) {
    await i.reply({ content: '数量必须为正整数。', ephemeral: true });
    return;
  }

  const grantItem = GRANT_ITEMS[couponType];
  if (!grantItem) {
    await i.reply({ content: '券种无效。', ephemeral: true });
    return;
  }

  // 先确认交互，避免批量发券时超过 Discord 3 秒响应窗口
  await i.deferReply({ ephemeral: false });

  try {
    const quantityText = quantity === 1 ? '一张' : `${quantity} 张`;

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    if (grantItem.couponType) {
      const data = Array.from({ length: quantity }, () => ({
        discordId: target.id,
        type: grantItem.couponType!,
        status: CouponStatus.ACTIVE,
        expiresAt,
      }));

      while (true) {
        try {
          await prisma.coupon.createMany({ data });
          break;
        } catch (err) {
          if (isUniqueConstraintError(err, 'id')) {
            await realignCouponSequence();
            continue;
          }
          throw err;
        }
      }
    } else if (grantItem.lotteryPrizeName) {
      const prize = await prisma.lotteryPrize.findFirst({
        where: { name: grantItem.lotteryPrizeName },
        select: { id: true, pool: true },
      });
      if (!prize) {
        await i.editReply({ content: `未找到奖品「${grantItem.lotteryPrizeName}」，请先在奖池创建。` });
        return;
      }

      for (let idx = 0; idx < quantity; idx++) {
        const nonce = `grant:${target.id}:${Date.now()}:${idx}:${crypto.randomBytes(4).toString('hex')}`;
        const code = `BSTACK-${crypto.randomBytes(4).toString('hex')}`;
        await prisma.lotteryDraw.create({
          data: {
            nonce,
            requestId: `grant:${i.id}`,
            userId: target.id,
            pool: prize.pool ?? LotteryPool.ADVANCED,
            prizeId: prize.id,
            cost: '0',
            random: Math.random(),
            status: LotteryStatus.UNUSED,
            code,
            expiresAt,
          },
        });
      }
    }

    const dmLines = [`收到${quantityText}${grantItem.label}！感谢老板对锦鲤的大力支持🩷`];
    if (grantItem.lotteryPrizeName === PRIZE_NAMES.BLOCK_STACK_VOUCHER) {
      dmLines.push('使用方法：输入!抽积木消耗该代金券');
    }
    const dmContent = dmLines.join('\n');

    try {
      await target.send({ content: dmContent });
    } catch (err) {
      console.error('[grantCoupon] failed to DM user about coupon', {
        targetId: target.id,
        err,
      });
    }

    await i.editReply({
      content: `已为 <@${target.id}> 增加 ${quantity} 张 ${grantItem.label}（有效期 30 天）。`,
    });
    return;
  } catch (err) {
    console.error('[grantCoupon] failed to grant coupon', {
      operatorId: i.user.id,
      targetId: target.id,
      couponType,
      quantity,
      err,
    });
    await i.editReply({ content: '送券失败，请稍后再试。' });
    return;
  }
}
