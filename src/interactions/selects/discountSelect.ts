import { Prisma, OrderStatus, CouponType, LotteryStatus } from '@prisma/client';
import { StringSelectMenuInteraction } from 'discord.js';
import prisma from '../../db/prisma.js';
import { round2 } from '../../lib/money.js';
import { recordIndividualTransaction } from '../../services/individualTransactionService.js';
import { suppressRechargeNotifications } from '../../services/rechargeNotifyConfig.js';
import { PRIZE_NAMES } from '../../services/lotteryService.js';

export async function handleDiscountSelect(i: StringSelectMenuInteraction) {
  if (!i.customId.startsWith('discount_box')) return;

  const [, orderId] = i.customId.split(':');
  const choice = i.values[0];

  if (!orderId || !choice) {
    await i.reply({ content: '无效的选项。' });
    return;
  }

  const discountRule =
    choice === 'jiuzhe'
      ? { kind: 'coupon' as const, label: '9折券', rate: 0.1, cap: new Prisma.Decimal(20) }
      : choice === 'bazhe'
        ? { kind: 'lottery' as const, label: '8折券', rate: 0.2, cap: new Prisma.Decimal(200) }
        : null;
  if (!discountRule) {
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
  let couponId: string | null = null;
  let lotteryId: string | null = null;

  const existingCouponUsage = await prisma.coupon.findFirst({
    where: { orderId, status: 'USED' },
    select: { id: true },
  });
  const existingLotteryUsage = await prisma.lotteryDraw.findFirst({
    where: {
      userId: i.user.id,
      status: LotteryStatus.USED,
      requestId: orderId,
      prize: { name: PRIZE_NAMES.DISCOUNT_80 },
    },
    select: { id: true },
  });
  if (existingCouponUsage || existingLotteryUsage) {
    await i.reply({ content: '该订单已使用过优惠券。' });
    return;
  }

  if (discountRule.kind === 'coupon') {
    await prisma.coupon.updateMany({
      where: {
        discordId: i.user.id,
        status: 'ACTIVE',
        expiresAt: { lte: now },
      },
      data: { status: 'EXPIRED' },
    });
    const availableCoupon = await prisma.coupon.findFirst({
      where: {
        discordId: i.user.id,
        type: CouponType.DISCOUNT_90,
        status: 'ACTIVE',
        expiresAt: { gt: now },
      },
      orderBy: { issuedAt: 'asc' },
    });
    if (!availableCoupon) {
      await i.reply({ content: '没有可用的九折券。' });
      return;
    }
    couponId = availableCoupon.id;
  } else {
    await prisma.lotteryDraw.updateMany({
      where: {
        userId: i.user.id,
        status: LotteryStatus.UNUSED,
        expiresAt: { lte: now },
        prize: { name: PRIZE_NAMES.DISCOUNT_80 },
      },
      data: { status: LotteryStatus.EXPIRED },
    });
    const voucher = await prisma.lotteryDraw.findFirst({
      where: {
        userId: i.user.id,
        status: LotteryStatus.UNUSED,
        expiresAt: { gt: now },
        prize: { name: PRIZE_NAMES.DISCOUNT_80 },
      },
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!voucher) {
      await i.reply({ content: '没有可用的 8 折券。' });
      return;
    }
    lotteryId = voucher.id;
  }

  const totalMinutes = order.totalMinutes ?? 0;
  if (!order.unitPrice) {
    await i.reply({ content: '订单信息不足，无法使用优惠。' });
    return;
  }

  if (totalMinutes <= 5) {
    await i.reply({ content: '该订单未产生费用，无法使用优惠券。' });
    return;
  }

  const cappedMinutes = Math.min(totalMinutes, 120);
  const billableMinutes = totalMinutes <= 120 ? Math.max(cappedMinutes - 5, 0) : 120;
  if (billableMinutes <= 0) {
    await i.reply({ content: '该订单未产生费用，无法使用优惠券。' });
    return;
  }

  const perMinute = new Prisma.Decimal(order.unitPrice).div(60);
  if (perMinute.lte(0)) {
    await i.reply({ content: '订单信息不足，无法使用优惠。' });
    return;
  }

  let discountAmount = round2(perMinute.mul(billableMinutes).mul(discountRule.rate));
  if (discountAmount.gt(discountRule.cap)) discountAmount = discountRule.cap;

  if (discountAmount.lte(0)) {
    await i.reply({ content: '该订单不符合优惠条件。' });
    return;
  }

  await i.deferUpdate();

  await prisma.$transaction(async (tx) => {
    await suppressRechargeNotifications(tx);
    const bossAccount = await tx.member.findUnique({
      where: { discordUserId: i.user.id },
      select: { totalBalance: true },
    });
    const balanceBefore = new Prisma.Decimal(bossAccount?.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(discountAmount);

    if (discountRule.kind === 'coupon' && couponId) {
      await tx.coupon.update({
        where: { id: couponId },
        data: {
          consumedAt: new Date(),
          orderId: order.id,
          discountAmount,
          status: 'USED',
        },
      });
    }
    if (discountRule.kind === 'lottery' && lotteryId) {
      await tx.lotteryDraw.update({
        where: { id: lotteryId },
        data: {
          status: LotteryStatus.USED,
          consumeAt: new Date(),
          requestId: order.id,
        },
      });
    }

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
    content: `已使用 ${discountRule.label}，本单返还 ¥${discountAmount.toFixed(2)}，金额已入账。`,
  });
}
