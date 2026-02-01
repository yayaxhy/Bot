import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import prisma from '../db/prisma.js';
import { CouponStatus, CouponType } from '@prisma/client';
import { isUniqueConstraintError, realignCouponSequence } from '../services/sequenceService.js';
import { isCashAdmin } from './cash.js';

type GrantItem = {
  label: string;
  couponType: CouponType;
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

  const quantityText = quantity === 1 ? '一张' : `${quantity} 张`;

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const data = Array.from({ length: quantity }, () => ({
    discordId: target.id,
    type: grantItem.couponType,
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

  const dmContent = `收到${quantityText}${grantItem.label}！感谢老板对锦鲤的大力支持🩷`;

  try {
    await target.send({ content: dmContent });
  } catch (err) {
    console.error('[grantCoupon] failed to DM user about coupon', {
      targetId: target.id,
      err,
    });
  }

  await i.reply({
    content: `已为 <@${target.id}> 增加 ${quantity} 张 ${grantItem.label}（有效期 30 天）。`,
    ephemeral: false,
  });
  return;
}
