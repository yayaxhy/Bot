import { Prisma, OrderStatus, CouponType } from '@prisma/client';
import { StringSelectMenuInteraction } from 'discord.js';
import prisma from '../../db/prisma.js';
import { round2 } from '../../lib/money.js';
import { recordIndividualTransaction } from '../../services/individualTransactionService.js';

export async function handleDiscountSelect(i: StringSelectMenuInteraction) {
  if (!i.customId.startsWith('discount_box')) return;

  const [, orderId] = i.customId.split(':');
  const choice = i.values[0];

  if (!orderId || !choice) {
    await i.reply({ content: '无效的选项。' });
    return;
  }

  if (choice !== 'jiuzhe') {
    await i.reply({ content: '当前暂不支持该优惠券。' });
    return;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      displayNo: true,
      hostId: true,
      workerId: true,
      unitPrice: true,
      totalMinutes: true,
      status: true,
    },
  });
  if (!order) {
    await i.reply({ content: '未找到对应订单。' });
    return;
  }

  if (order.hostId !== i.user.id) {
    await i.reply({ content: '只有该订单的老板可以使用优惠券。' });
    return;
  }

  if (order.status !== OrderStatus.ENDED) {
    await i.reply({ content: '订单尚未结单，暂无法使用优惠券。' });
    return;
  }

  const now = new Date();
  const availableCoupon = await prisma.coupon.findFirst({
    where: {
      discordId: i.user.id,
      type: CouponType.DISCOUNT_90,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { issuedAt: 'asc' },
  });
  if (!availableCoupon) {
    await i.reply({ content: '没有可用的九折券。' });
    return;
  }

  const existing = await prisma.coupon.findFirst({
    where: { orderId, consumedAt: { not: null } },
    select: { id: true },
  });
  if (existing) {
    await i.reply({ content: '该订单已使用过优惠券。' });
    return;
  }

  const minutes = Math.min(order.totalMinutes ?? 0, 120);
  if (minutes <= 0 || !order.unitPrice) {
    await i.reply({ content: '订单信息不足，无法使用优惠。' });
    return;
  }

  const perMinute = new Prisma.Decimal(order.unitPrice).div(60);
  let discountAmount = round2(perMinute.mul(minutes).mul(0.1));
  const maxDiscount = new Prisma.Decimal(20);
  if (discountAmount.gt(maxDiscount)) discountAmount = maxDiscount;

  if (discountAmount.lte(0)) {
    await i.reply({ content: '该订单不符合优惠条件。' });
    return;
  }

  await i.deferUpdate();

  await prisma.$transaction(async (tx) => {
    const bossAccount = await tx.member.findUnique({
      where: { discordUserId: i.user.id },
      select: { totalBalance: true },
    });
    const balanceBefore = new Prisma.Decimal(bossAccount?.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(discountAmount);

    await tx.coupon.update({
      where: { id: availableCoupon.id },
      data: {
        consumedAt: new Date(),
        orderId: order.id,
      },
    });

    await tx.member.update({
      where: { discordUserId: i.user.id },
      data: {
        recharge: { increment: discountAmount },
        totalBalance: { increment: discountAmount },
      },
    });

    await recordIndividualTransaction(tx, {
      discordId: i.user.id,
      thirdPartydiscordId: order.workerId ?? 'SYSTEM',
      balanceBefore,
      amountChange: discountAmount,
      balanceAfter,
      typeOfTransaction: '优惠返利',
    });
  });

  await i.editReply({ components: [] });
  await i.followUp({
    content: `已使用 9折券，本单返还 ¥${discountAmount.toFixed(2)}，金额已入账。`,
  });
}
