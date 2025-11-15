import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import prisma from '../db/prisma.js';
import { CouponStatus, CouponType } from '@prisma/client';
import { isUniqueConstraintError, realignCouponSequence } from '../services/sequenceService.js';
import { isCashAdmin } from './cash.js';

export const grantCouponCommand = new SlashCommandBuilder()
  .setName('送券')
  .setDescription('给指定用户发放优惠券')
  .addStringOption((option) =>
    option
      .setName('券种')
      .setDescription('选择要发放的优惠券类型')
      .setRequired(true)
      .addChoices({ name: '9折券', value: 'DISCOUNT_90' })
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

  if (couponType !== 'DISCOUNT_90') {
    await i.reply({ content: '目前仅支持 9折券。', ephemeral: true });
    return;
  }

  if (!quantity || quantity <= 0) {
    await i.reply({ content: '数量必须为正整数。', ephemeral: true });
    return;
  }

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const data = Array.from({ length: quantity }, () => ({
    discordId: target.id,
    type: CouponType.DISCOUNT_90,
    status: CouponStatus.ACTIVE,
    expiresAt,
  }));

  while (true) {
    try {
      await prisma.coupon.createMany({ data });
      break;
    } catch (err) {
      if (isUniqueConstraintError(err, 'id')) {
        await realignCouponSequence(prisma);
        continue;
      }
      throw err;
    }
  }

  await i.reply({
    content: `已为 <@${target.id}> 增加 ${quantity} 张 9折券（有效期 30 天）。`,
    ephemeral: false,
  });
}
