import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import prisma from '../db/prisma.js';
import { CouponSource, CouponStatus, CouponType } from '@prisma/client';
import { isUniqueConstraintError, realignCouponSequence } from '../services/sequenceService.js';
import { isCashAdmin } from './cash.js';
import { ensureJinleeIdentityForDiscordTx } from '../services/jinleeAccountService.js';

type GrantItem = {
  label: string;
  couponType?: CouponType;
};

const MAX_GRANT_QUANTITY = 10;

const GRANT_ITEMS: Record<string, GrantItem> = {
  DISCOUNT_90: { label: '9折券', couponType: CouponType.DISCOUNT_90 },
  LOTTERY_DISCOUNT_80: { label: '8折券', couponType: CouponType.DISCOUNT_80 },
  LOTTERY_DISCOUNT_70: { label: '7折券', couponType: CouponType.DISCOUNT_70 },
  LOTTERY_DISCOUNT_90: { label: '特殊9折券', couponType: CouponType.DISCOUNT_90_LOTTERY },
  CROWN_DAY_95: { label: '一日冠95折券', couponType: CouponType.CROWN_DAY_95_VOUCHER },
  CROWN_DAY_92: { label: '一日冠92折券', couponType: CouponType.CROWN_DAY_92_VOUCHER },
  CROWN_75: { label: '一日冠75折券', couponType: CouponType.CROWN_75_VOUCHER },
  CROWN_DAY_90: { label: '一日冠9折券', couponType: CouponType.CROWN_DAY_90_VOUCHER },
  CROWN_3DAY_92: { label: '三日冠92折券', couponType: CouponType.CROWN_3DAY_92_VOUCHER },
  CROWN_3DAY_90: { label: '三日冠9折券', couponType: CouponType.CROWN_3DAY_90_VOUCHER },
  CROWN_WEEK_92: { label: '一周冠92折券', couponType: CouponType.CROWN_WEEK_92_VOUCHER },
  CROWN_WEEK_90: { label: '一周冠9折券', couponType: CouponType.CROWN_WEEK_90_VOUCHER },
  CROWN_MONTH_92: { label: '月冠名92折券', couponType: CouponType.CROWN_MONTH_92_VOUCHER },
  CROWN_MONTH_90: { label: '月冠名9折券', couponType: CouponType.CROWN_MONTH_90_VOUCHER },
  LOTTERY_VOUCHER: { label: '抽奖代金券', couponType: CouponType.LOTTERY_VOUCHER },
  PEIWAN_REVIEW: { label: '陪玩评语券', couponType: CouponType.PEIWAN_REVIEW_VOUCHER },
  DOUBLE_FLOW_5000: { label: '双倍流水5000券', couponType: CouponType.DOUBLE_FLOW_5000_VOUCHER },
  DOUBLE_SPEND_5000: { label: '双倍消费5000券', couponType: CouponType.DOUBLE_SPEND_5000_VOUCHER },
  SCRATCH_TICKET: { label: '刮刮乐代金券', couponType: CouponType.SCRATCH_TICKET_VOUCHER },
  BLOCK_STACK_VOUCHER: { label: '积木游戏代金券', couponType: CouponType.BLOCK_STACK_VOUCHER },
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
      .setMaxValue(MAX_GRANT_QUANTITY)
  )
  .addUserOption((option) =>
    option
      .setName('用户')
      .setDescription('要发券的用户')
      .setRequired(true)
  );

export async function handleGrantCouponSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '送券') return;

  const respond = async (content: string, ephemeral = false) => {
    if (i.deferred || i.replied) {
      await i.editReply({ content });
      return;
    }
    await i.reply({ content, ephemeral });
  };

  console.log('[grantCoupon] slash invoked', {
    interactionId: i.id,
    guildId: i.guildId,
    userId: i.user.id,
  });

  try {
    if (!i.deferred && !i.replied) {
      try {
        // 先确认交互，避免任何后续分支超时
        await i.deferReply({ ephemeral: false });
      } catch (err) {
        console.error('[grantCoupon] defer failed', { interactionId: i.id, err });
      }
    }

    if (!isCashAdmin(i)) {
      await respond('❌ 你没有权限使用该命令。', true);
      return;
    }

    const couponType = i.options.getString('券种', true);
    const quantity = i.options.getInteger('数量', true);
    const target = i.options.getUser('用户', true);

    if (!quantity || quantity <= 0) {
      await respond('数量必须为正整数。', true);
      return;
    }
    if (quantity > MAX_GRANT_QUANTITY) {
      await respond(`数量不能超过 ${MAX_GRANT_QUANTITY} 张。`, true);
      return;
    }

    const grantItem = GRANT_ITEMS[couponType];
    if (!grantItem) {
      await respond('券种无效。', true);
      return;
    }

    const quantityText = quantity === 1 ? '一张' : `${quantity} 张`;

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const targetIdentity = await ensureJinleeIdentityForDiscordTx(prisma, target.id);
    if (grantItem.couponType) {
      const data = Array.from({ length: quantity }, () => ({
        discordId: target.id,
        jinleeId: targetIdentity.jinleeId,
        type: grantItem.couponType!,
        source: CouponSource.MANUAL_GRANT,
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
    }

    const dmLines = [`收到${quantityText}${grantItem.label}！感谢老板对锦鲤的大力支持🩷`];
    if (grantItem.couponType === CouponType.BLOCK_STACK_VOUCHER) {
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

    await respond(
      `已为 <@${target.id}> 增加 ${quantity} 张 ${grantItem.label}（有效期 30 天）。`,
      false
    );
    return;
  } catch (err) {
    console.error('[grantCoupon] failed to grant coupon', {
      operatorId: i.user.id,
      err,
    });
    try {
      await respond('送券失败，请稍后再试。', true);
    } catch {}
    return;
  }
}
