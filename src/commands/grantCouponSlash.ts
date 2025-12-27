import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import prisma from '../db/prisma.js';
import { CouponStatus, CouponType, Prisma } from '@prisma/client';
import { isUniqueConstraintError, realignCouponSequence } from '../services/sequenceService.js';
import { isCashAdmin } from './cash.js';
import { PRIZE_NAMES } from '../services/lotteryService.js';

type GrantKind = 'coupon' | 'lottery';

type GrantItem = {
  kind: GrantKind;
  label: string;
  couponType?: CouponType;
  prizeName?: string;
};

const LOTTERY_VOUCHER_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;

const GRANT_ITEMS: Record<string, GrantItem> = {
  DISCOUNT_90: { kind: 'coupon', label: '9折券', couponType: CouponType.DISCOUNT_90 },
  LOTTERY_DISCOUNT_80: { kind: 'lottery', label: '8折券', prizeName: PRIZE_NAMES.DISCOUNT_80 },
  LOTTERY_DISCOUNT_70: { kind: 'lottery', label: '7折券', prizeName: PRIZE_NAMES.DISCOUNT_70 },
  LOTTERY_DISCOUNT_90: { kind: 'lottery', label: '特殊9折券', prizeName: PRIZE_NAMES.DISCOUNT_90_LOTTERY },
  LOLLIPOP: { kind: 'lottery', label: '棒棒糖代金券', prizeName: PRIZE_NAMES.LOLLIPOP_VOUCHER },
  PERFUME: { kind: 'lottery', label: '香水代金券', prizeName: PRIZE_NAMES.PERFUME_VOUCHER },
  CAROUSEL: { kind: 'lottery', label: '旋转木马代金券', prizeName: PRIZE_NAMES.CAROUSEL_VOUCHER },
  PUMPKIN_CAR: { kind: 'lottery', label: '南瓜车代金券', prizeName: PRIZE_NAMES.PUMPKIN_CAR_VOUCHER },
  PHONOGRAPH: { kind: 'lottery', label: '留声机代金券', prizeName: PRIZE_NAMES.PHONOGRAPH_VOUCHER },
  CROWN_75: { kind: 'lottery', label: '一日冠75折券', prizeName: PRIZE_NAMES.CROWN_75_VOUCHER },
  RENAME_CARD_3: { kind: 'lottery', label: '3位数靓号卡', prizeName: PRIZE_NAMES.RENAME_CARD_3 },
  RENAME_CARD_4: { kind: 'lottery', label: '4位数靓号卡', prizeName: PRIZE_NAMES.RENAME_CARD },
  RENAME_CARD_5: { kind: 'lottery', label: '5位数靓号卡', prizeName: PRIZE_NAMES.RENAME_CARD_5 },
  LOTTERY_VOUCHER: { kind: 'lottery', label: '抽奖代金券', prizeName: PRIZE_NAMES.LOTTERY_VOUCHER },
  CUSTOM_GIFT: { kind: 'lottery', label: '自定义礼物券', prizeName: PRIZE_NAMES.CUSTOM_GIFT_VOUCHER },
  CUSTOM_TAG: { kind: 'lottery', label: '自定义tag券', prizeName: PRIZE_NAMES.CUSTOM_TAG_VOUCHER },
  COMMISSION_MINUS1: { kind: 'lottery', label: '抽成降1%券', prizeName: PRIZE_NAMES.COMMISSION_MINUS1_VOUCHER },
  DOUBLE_FLOW_5000: { kind: 'lottery', label: '双倍流水5000券', prizeName: PRIZE_NAMES.DOUBLE_FLOW_5000_VOUCHER },
  DOUBLE_SPEND_5000: { kind: 'lottery', label: '双倍消费5000券', prizeName: PRIZE_NAMES.DOUBLE_SPEND_5000_VOUCHER },
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

  if (grantItem.kind === 'coupon' && grantItem.couponType) {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
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

  if (grantItem.kind === 'lottery' && grantItem.prizeName) {
    const prize = await prisma.lotteryPrize.findFirst({
      where: { name: grantItem.prizeName },
      select: { id: true, pool: true },
    });
    if (!prize) {
      await i.reply({
        content: `未找到奖品「${grantItem.label}」，请先在奖池中配置。`,
        ephemeral: true,
      });
      return;
    }

    const now = Date.now();
    const expiresAt = new Date(now + LOTTERY_VOUCHER_EXPIRES_MS);
    const cost = new Prisma.Decimal(0);
    const data = Array.from({ length: quantity }, (_, idx) => ({
      nonce: `grant:${couponType}:${target.id}:${now}:${idx}`,
      userId: target.id,
      pool: prize.pool,
      prizeId: prize.id,
      cost,
      random: Math.random(),
      expiresAt,
    }));

    await prisma.lotteryDraw.createMany({ data });

    const dmContent = `收到${quantityText}${grantItem.label}（抽奖券）！感谢老板对锦鲤的大力支持🩷`;
    try {
      await target.send({ content: dmContent });
    } catch (err) {
      console.error('[grantLotteryVoucher] failed to DM user about voucher', {
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

  await i.reply({ content: '券种配置缺失。', ephemeral: true });
}
