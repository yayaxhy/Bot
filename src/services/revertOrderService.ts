import { CouponType, LotteryStatus, OrderStatus, Prisma, PrismaClient } from '@prisma/client';
import prisma from '../db/prisma.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { syncSpentRolesForMember } from './spentRoleService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';
import { adjustLoyaltyPointsTx } from './loyaltyPointService.js';
import { getSpendBuffRemaining } from './buffService.js';
import { PRIZE_NAMES } from './lotteryService.js';
import { evaluateAutoCommissionBuffWithReason } from './autoCommissionBuffService.js';

type TxLike = PrismaClient | Prisma.TransactionClient;

const DEC = (n: Prisma.Decimal | number | string) =>
  n instanceof Prisma.Decimal ? n : new Prisma.Decimal(n);

const DISCOUNT_PRIZE_NAMES = [
  PRIZE_NAMES.DISCOUNT_80,
  PRIZE_NAMES.DISCOUNT_70,
  PRIZE_NAMES.DISCOUNT_90_LOTTERY,
  '特殊九折券',
];

function couponTypeLabel(type: CouponType): string {
  switch (type) {
    case CouponType.DISCOUNT_70:
      return '7折券';
    case CouponType.DISCOUNT_80:
      return '8折券';
    case CouponType.DISCOUNT_90:
      return '9折券';
    case CouponType.DISCOUNT_90_LOTTERY:
      return '特殊9折券';
    default:
      return String(type);
  }
}

type RevertOrderParams = {
  orderId: string; // Order.id (cuid) or displayNo
  operatorId: string;
  reason?: string | null;
};

async function findOrderForRevert(tx: TxLike, rawOrderId: string) {
  const select = {
    id: true,
    displayNo: true,
    hostId: true,
    workerId: true,
    peiwanId: true,
    status: true,
    grossAmount: true,
    netAmount: true,
  } as const;

  const input = rawOrderId.trim();
  if (/^\d+$/.test(input)) {
    return tx.order.findUnique({
      where: { displayNo: Number(input) },
      select,
    });
  }

  return tx.order.findUnique({
    where: { id: input },
    select,
  });
}

async function restoreSpendBuff(
  tx: TxLike,
  userId: string,
  used: Prisma.Decimal,
  capBefore: Prisma.Decimal,
) {
  if (used.lte(0) || capBefore.lte(0)) return;
  const current = await getSpendBuffRemaining(tx, userId);
  let next = current.add(used);
  if (next.gt(capBefore)) next = capBefore;
  await tx.$executeRaw`
    INSERT INTO spend_buff (user_id, remaining_extra, expires_at, created_at, updated_at)
    VALUES (${userId}, ${next}, now() + interval '30 day', now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET remaining_extra = ${next},
          updated_at = now()
  `;
}

export async function revertOrderByOrderId(params: RevertOrderParams) {
  const { orderId, operatorId, reason } = params;

  const result = await prisma.$transaction(async (tx) => {
    await suppressRechargeNotifications(tx);

    const order = await findOrderForRevert(tx, orderId);
    if (!order) throw new Error('order_not_found');
    if (order.status !== OrderStatus.ENDED) throw new Error('order_not_ended');

    const revertKey = `ORDER:${order.id}`;
    const existing = await tx.revert.findUnique({
      where: { originalTransactionId: revertKey },
    });
    if (existing) throw new Error('already_reverted');

    const audit = await tx.orderAudit.findUnique({
      where: { orderId: order.id },
    });
    if (!audit) throw new Error('order_audit_not_found');

    const gross = DEC(audit.gross);
    const netAmount = DEC(audit.netAmount);
    if (gross.lte(0) && netAmount.lte(0)) throw new Error('order_amount_empty');

    const hostFromIncome = DEC(audit.hostFromIncome);
    const hostFromRecharge = DEC(audit.hostFromRecharge);
    const pointsEarned = DEC(audit.pointsEarned);
    const spendExtra = DEC(audit.spendBonusExtra);
    const spendCap = DEC(audit.spendRemainingBefore);

    const usedCoupons = await tx.coupon.findMany({
      where: {
        discordId: order.hostId,
        orderId: order.id,
        status: 'USED',
      },
      select: {
        id: true,
        consumeAmount: true,
        type: true,
      },
    });

    const usedLottery = await tx.lotteryDraw.findMany({
      where: {
        userId: order.hostId,
        status: LotteryStatus.USED,
        requestId: order.id,
        prize: { name: { in: DISCOUNT_PRIZE_NAMES } },
      },
      select: {
        id: true,
        consumeAmount: true,
      },
    });

    const couponDiscount = usedCoupons.reduce(
      (sum, c) => sum.add(DEC(c.consumeAmount ?? 0)),
      new Prisma.Decimal(0),
    );
    const lotteryDiscount = usedLottery.reduce(
      (sum, l) => sum.add(DEC(l.consumeAmount ?? 0)),
      new Prisma.Decimal(0),
    );
    const totalDiscountAmount = couponDiscount.add(lotteryDiscount);

    const revertRow = await tx.revert.create({
      data: {
        originalTransactionId: revertKey,
        operatorId,
        reason: reason ?? undefined,
        status: 'PENDING',
      },
    });

    await tx.$queryRaw`SELECT 1 FROM "Member" WHERE "discordUserId" = ${order.hostId} FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM "Member" WHERE "discordUserId" = ${order.workerId} FOR UPDATE`;

    const host = await tx.member.findUnique({
      where: { discordUserId: order.hostId },
      select: { totalBalance: true, income: true, recharge: true, totalSpent: true },
    });
    const worker = await tx.member.findUnique({
      where: { discordUserId: order.workerId },
      select: { totalBalance: true, income: true },
    });
    if (!host || !worker) throw new Error('member_missing');

    const hostBalanceBefore = DEC(host.totalBalance ?? 0);
    const hostIncomeBefore = DEC(host.income ?? 0);
    const hostRechargeBefore = DEC(host.recharge ?? 0);
    const hostTotalSpentBefore = DEC(host.totalSpent ?? 0);

    const hostBalanceDelta = gross.sub(totalDiscountAmount);
    const hostRechargeDelta = hostFromRecharge.sub(totalDiscountAmount);

    let hostIncomeAfter = hostIncomeBefore.add(hostFromIncome);
    let hostRechargeAfter = hostRechargeBefore.add(hostRechargeDelta);
    let hostBalanceAfter = hostBalanceBefore.add(hostBalanceDelta);
    let hostTotalSpentAfter = hostTotalSpentBefore.sub(gross.add(spendExtra));
    if (hostIncomeAfter.lt(0)) hostIncomeAfter = DEC(0);
    if (hostRechargeAfter.lt(0)) hostRechargeAfter = DEC(0);
    if (hostBalanceAfter.lt(0)) hostBalanceAfter = DEC(0);
    if (hostTotalSpentAfter.lt(0)) hostTotalSpentAfter = DEC(0);

    await tx.member.update({
      where: { discordUserId: order.hostId },
      data: {
        income: hostIncomeAfter,
        recharge: hostRechargeAfter,
        totalBalance: hostBalanceAfter,
        totalSpent: hostTotalSpentAfter,
      },
    });
    await adjustLoyaltyPointsTx(tx, order.hostId, pointsEarned.mul(-1));

    const hostNetRefund = hostBalanceAfter.sub(hostBalanceBefore);
    if (hostNetRefund.gt(0)) {
      await recordIndividualTransaction(tx, {
        discordId: order.hostId,
        thirdPartydiscordId: order.workerId,
        balanceBefore: hostBalanceBefore,
        amountChange: hostNetRefund,
        balanceAfter: hostBalanceAfter,
        typeOfTransaction: '订单撤销',
      });
    }

    const workerBalanceBefore = DEC(worker.totalBalance ?? 0);
    const workerIncomeBefore = DEC(worker.income ?? 0);
    let workerBalanceAfter = workerBalanceBefore.sub(netAmount);
    let workerIncomeAfter = workerIncomeBefore.sub(netAmount);
    if (workerBalanceAfter.lt(0)) workerBalanceAfter = DEC(0);
    if (workerIncomeAfter.lt(0)) workerIncomeAfter = DEC(0);

    await tx.member.update({
      where: { discordUserId: order.workerId },
      data: {
        income: workerIncomeAfter,
        totalBalance: workerBalanceAfter,
      },
    });

    if (netAmount.gt(0)) {
      await recordIndividualTransaction(tx, {
        discordId: order.workerId,
        thirdPartydiscordId: order.hostId,
        balanceBefore: workerBalanceBefore,
        amountChange: netAmount,
        balanceAfter: workerBalanceAfter,
        typeOfTransaction: '订单撤销',
      });
    }

    const peiwan = await tx.pEIWAN.findUnique({
      where: { PEIWANID: order.peiwanId },
      select: { totalEarn: true },
    });
    if (peiwan) {
      let totalEarnAfter = DEC(peiwan.totalEarn ?? 0).sub(gross);
      if (totalEarnAfter.lt(0)) totalEarnAfter = DEC(0);
      await tx.pEIWAN.update({
        where: { PEIWANID: order.peiwanId },
        data: {
          totalEarn: totalEarnAfter,
          balance: workerBalanceAfter,
        },
      });
    }

    if (usedCoupons.length) {
      await tx.coupon.updateMany({
        where: { id: { in: usedCoupons.map((v) => v.id) } },
        data: {
          status: 'ACTIVE',
          consumedAt: null,
          consumeAmount: null,
          consumeTargetId: null,
          orderId: null,
        },
      });
    }
    if (usedLottery.length) {
      await tx.lotteryDraw.updateMany({
        where: { id: { in: usedLottery.map((v) => v.id) } },
        data: {
          status: LotteryStatus.UNUSED,
          consumeAt: null,
          consumeAmount: null,
          consumeOrderId: null,
          consumeTargetId: null,
          requestId: null,
        },
      });
    }

    await restoreSpendBuff(tx, order.hostId, spendExtra, spendCap);

    const referralRollbacks: Array<{ inviterId: string; inviteeId: string; amount: Prisma.Decimal }> = [];
    if (audit.bossReferralInviterId && DEC(audit.bossReferralAmount ?? 0).gt(0)) {
      referralRollbacks.push({
        inviterId: audit.bossReferralInviterId,
        inviteeId: order.hostId,
        amount: DEC(audit.bossReferralAmount ?? 0),
      });
    }
    if (audit.workerReferralInviterId && DEC(audit.workerReferralAmount ?? 0).gt(0)) {
      referralRollbacks.push({
        inviterId: audit.workerReferralInviterId,
        inviteeId: order.workerId,
        amount: DEC(audit.workerReferralAmount ?? 0),
      });
    }

    for (const rollback of referralRollbacks) {
      const inviter = await tx.member.upsert({
        where: { discordUserId: rollback.inviterId },
        create: { discordUserId: rollback.inviterId },
        update: {},
        select: { totalBalance: true, recharge: true },
      });

      const inviterBalanceBefore = DEC(inviter.totalBalance ?? 0);
      const inviterRechargeBefore = DEC(inviter.recharge ?? 0);
      let inviterBalanceAfter = inviterBalanceBefore.sub(rollback.amount);
      let inviterRechargeAfter = inviterRechargeBefore.sub(rollback.amount);
      if (inviterBalanceAfter.lt(0)) inviterBalanceAfter = DEC(0);
      if (inviterRechargeAfter.lt(0)) inviterRechargeAfter = DEC(0);

      await tx.member.update({
        where: { discordUserId: rollback.inviterId },
        data: {
          totalBalance: inviterBalanceAfter,
          recharge: inviterRechargeAfter,
        },
      });

      await recordIndividualTransaction(tx, {
        discordId: rollback.inviterId,
        thirdPartydiscordId: rollback.inviteeId,
        balanceBefore: inviterBalanceBefore,
        amountChange: rollback.amount,
        balanceAfter: inviterBalanceAfter,
        typeOfTransaction: '邀请提成撤销',
      });
    }

    await tx.referralPayout.deleteMany({
      where: { orderId: order.id },
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        grossAmount: DEC(0),
        netAmount: DEC(0),
        chargedGross: DEC(0),
        chargedMinutes: 0,
      },
    });

    await tx.revert.update({
      where: { id: revertRow.id },
      data: {
        status: 'SUCCESS',
        details: {
          orderId: order.id,
          displayNo: order.displayNo,
          gross: gross.toString(),
          netAmount: netAmount.toString(),
          hostNetRefund: hostNetRefund.toString(),
          discountRollbackAmount: totalDiscountAmount.toString(),
          usingAudit: true,
        } as any,
      },
    });

    return {
      order,
      gross,
      netAmount,
      hostNetRefund,
      returnedCouponNames: Array.from(
        new Set(usedCoupons.map((coupon) => couponTypeLabel(coupon.type))),
      ),
    };
  });

  try {
    await syncSpentRolesForMember(result.order.hostId);
    await syncSpentRolesForMember(result.order.workerId, { includeSpendRoles: false });
  } catch (err) {
    console.error('[revert-order] sync roles failed', err);
  }
  evaluateAutoCommissionBuffWithReason(result.order.workerId, 'revert').catch((err) =>
    console.error('[revert-order] auto commission eval failed', err),
  );

  try {
    const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
    if (client) {
      const host = await client.users.fetch(result.order.hostId).catch(() => null);
      const worker = await client.users.fetch(result.order.workerId).catch(() => null);
      const hostDelta = DEC(result.hostNetRefund);
      const hostDeltaText = Number(hostDelta.abs().toString()).toFixed(2);
      const deductText = Number(result.netAmount.toString()).toFixed(2);
      const hostName = host?.username || (host as any)?.displayName || result.order.hostId;
      const workerName = worker?.username || (worker as any)?.displayName || result.order.workerId;
      const couponText = result.returnedCouponNames.join('、');

      if (host) {
        if (hostDelta.gte(0)) {
          const message =
            result.returnedCouponNames.length > 0
              ? `您与陪玩${workerName}的订单已撤销，金额 ¥${hostDeltaText} 已返还。优惠券${couponText}也已返还。`
              : `您与陪玩${workerName}的订单已撤销，金额 ¥${hostDeltaText} 已返还。`;
          await host.send(message).catch(() => {});
        } else {
          await host
            .send(`你的订单已撤销，且已使用的优惠返利已回收，净调整 ¥${hostDeltaText}。`)
            .catch(() => {});
        }
      }
      if (worker) {
        await worker
          .send(`有一笔订单（老板 ${hostName}）已被撤销，金额 ¥${deductText} 已扣回。`)
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error('[revert-order] notify failed', err);
  }

  return result;
}
