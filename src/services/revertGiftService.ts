import { LotteryStatus, Prisma, PrismaClient } from '@prisma/client';
import prisma from '../db/prisma.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { syncSpentRolesForMember } from './spentRoleService.js';
import { getFlowBuffRemaining, getSpendBuffRemaining } from './buffService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';

type TxLike = PrismaClient | Prisma.TransactionClient;

const DEC = (n: Prisma.Decimal | number | string) =>
  n instanceof Prisma.Decimal ? n : new Prisma.Decimal(n);

async function restoreSpendBuff(
  tx: TxLike,
  userId: string,
  used: Prisma.Decimal,
  capBefore: Prisma.Decimal
) {
  if (used.lte(0)) return;
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

async function restoreFlowBuff(
  tx: TxLike,
  userId: string,
  used: Prisma.Decimal,
  capBefore: Prisma.Decimal
) {
  if (used.lte(0)) return;
  const current = await getFlowBuffRemaining(tx, userId);
  let next = current.add(used);
  if (next.gt(capBefore)) next = capBefore;
  await tx.$executeRaw`
    INSERT INTO flow_buff (user_id, remaining_extra, expires_at, created_at, updated_at)
    VALUES (${userId}, ${next}, now() + interval '30 day', now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET remaining_extra = ${next},
          updated_at = now()
  `;
}

type RevertGiftParams = {
  transactionId: string; // individualTransaction.transactionId
  operatorId: string;
  reason?: string | null;
};

export async function revertGiftByIndividualTx(params: RevertGiftParams) {
  const { transactionId, operatorId, reason } = params;

  const result = await prisma.$transaction(async (tx) => {
    // 撤销过程中不触发充值通知
    await suppressRechargeNotifications(tx);

    const existing = await tx.revert.findUnique({ where: { originalTransactionId: transactionId } });
    if (existing) {
      throw new Error('already_reverted');
    }

    const audit = await tx.giftAudit.findUnique({
      where: { individualTransactionId: transactionId },
    });
    if (!audit) {
      throw new Error('gift_not_found');
    }

    const revertRow = await tx.revert.create({
      data: {
        originalTransactionId: transactionId,
        operatorId,
        reason: reason ?? undefined,
        status: 'PENDING',
      },
    });

    const payable = DEC(audit.payable);
    const gross = DEC(audit.gross);
    const netAmount = DEC(audit.netAmount);
    const spendExtra = DEC(audit.spendBonusExtra ?? 0);
    const spendCap = DEC(audit.spendRemainingBefore ?? 0);
    const flowExtra = DEC(audit.flowBonusExtra ?? 0);
    const flowCap = DEC(audit.flowRemainingBefore ?? 0);
    const heartGain = audit.heartGain ?? 0;
    const voucherIds = Array.isArray(audit.voucherIds) ? (audit.voucherIds as any[]) : [];

    const giver = await tx.member.findUnique({
      where: { discordUserId: audit.giverId },
      select: { income: true, recharge: true, totalBalance: true, totalSpent: true },
    });
    const receiver = await tx.member.findUnique({
      where: { discordUserId: audit.receiverId },
      select: { income: true, recharge: true, totalBalance: true },
    });
    const receiverPeiwan = await tx.pEIWAN.findUnique({
      where: { discordUserId: audit.receiverId },
      select: { totalEarn: true },
    });
    if (!giver || !receiver) throw new Error('member_missing');

    const giverBalanceBefore = DEC(giver.totalBalance ?? 0);
    const giverIncomeBefore = DEC(giver.income ?? 0);
    const giverRechargeBefore = DEC(giver.recharge ?? 0);
    const giverTotalSpentBefore = DEC(giver.totalSpent ?? 0);
    const giverBalanceAfter = giverBalanceBefore.add(payable);
    let giverTotalSpentAfter = giverTotalSpentBefore.sub(payable.add(spendExtra));
    if (giverTotalSpentAfter.lt(0)) giverTotalSpentAfter = DEC(0);

    await tx.member.update({
      where: { discordUserId: audit.giverId },
      data: {
        income: { increment: audit.giverFromIncome },
        recharge: { increment: audit.giverFromRecharge },
        totalBalance: { increment: payable },
        totalSpent: giverTotalSpentAfter,
      },
    });

    await recordIndividualTransaction(tx, {
      discordId: audit.giverId,
      thirdPartydiscordId: audit.receiverId,
      balanceBefore: giverBalanceBefore,
      amountChange: payable,
      balanceAfter: giverBalanceAfter,
      typeOfTransaction: '打赏撤销',
    });

    const receiverBalanceBefore = DEC(receiver.totalBalance ?? 0);
    const receiverIncomeBefore = DEC(receiver.income ?? 0);
    const receiverBalanceAfter = receiverBalanceBefore.sub(netAmount);
    const receiverIncomeAfter = receiverIncomeBefore.sub(netAmount);

    await tx.member.update({
      where: { discordUserId: audit.receiverId },
      data: {
        income: receiverIncomeAfter,
        totalBalance: receiverBalanceAfter,
      },
    });

    if (receiverPeiwan) {
      const totalEarnBefore = DEC(receiverPeiwan.totalEarn ?? 0);
      let totalEarnAfter = totalEarnBefore.sub(gross.add(flowExtra));
      if (totalEarnAfter.lt(0)) totalEarnAfter = DEC(0);
      await tx.pEIWAN.update({
        where: { discordUserId: audit.receiverId },
        data: {
          balance: receiverBalanceAfter,
          totalEarn: totalEarnAfter,
        },
      });
    }

    await recordIndividualTransaction(tx, {
      discordId: audit.receiverId,
      thirdPartydiscordId: audit.giverId,
      balanceBefore: receiverBalanceBefore,
      amountChange: netAmount,
      balanceAfter: receiverBalanceAfter,
      typeOfTransaction: '打赏撤销',
    });

    if (voucherIds.length) {
      await tx.lotteryDraw.updateMany({
        where: { id: { in: voucherIds as string[] } },
        data: { status: LotteryStatus.UNUSED, consumeAt: null, requestId: null },
      });
    }

    await restoreSpendBuff(tx, audit.giverId, spendExtra, spendCap);
    await restoreFlowBuff(tx, audit.receiverId, flowExtra, flowCap);

    if (heartGain > 0) {
      const counter = await tx.heartCounter.findUnique({
        where: {
          fromMemberId_toMemberId: { fromMemberId: audit.giverId, toMemberId: audit.receiverId },
        },
        select: { total: true },
      });
      if (counter) {
        const newTotal = Math.max(0, Number(DEC(counter.total).sub(heartGain).toNumber()));
        await tx.heartCounter.update({
          where: {
            fromMemberId_toMemberId: { fromMemberId: audit.giverId, toMemberId: audit.receiverId },
          },
          data: { total: newTotal },
        });
      }
    }

    // Referral rollback - boss side
    if (audit.bossReferralInviterId && audit.bossReferralAmount) {
      const amt = DEC(audit.bossReferralAmount);
      await tx.referralPayout.deleteMany({
        where: { referralId: audit.giverId, orderId: audit.orderId.toString() },
      });

      const inviter = await tx.member.upsert({
        where: { discordUserId: audit.bossReferralInviterId },
        create: { discordUserId: audit.bossReferralInviterId },
        update: {},
        select: { totalBalance: true, income: true },
      });

      const inviterBalanceBefore = DEC(inviter.totalBalance ?? 0);
      const inviterIncomeBefore = DEC(inviter.income ?? 0);
      const inviterBalanceAfter = inviterBalanceBefore.sub(amt);
      const inviterIncomeAfter = inviterIncomeBefore.sub(amt);

      await tx.member.update({
        where: { discordUserId: audit.bossReferralInviterId },
        data: {
          totalBalance: inviterBalanceAfter,
          income: inviterIncomeAfter,
        },
      });

      await recordIndividualTransaction(tx, {
        discordId: audit.bossReferralInviterId,
        thirdPartydiscordId: audit.giverId,
        balanceBefore: inviterBalanceBefore,
        amountChange: amt,
        balanceAfter: inviterBalanceAfter,
        typeOfTransaction: '邀请提成撤销',
      });
    }

    // Referral rollback - worker side
    if (audit.workerReferralInviterId && audit.workerReferralAmount) {
      const amt = DEC(audit.workerReferralAmount);
      await tx.referralPayout.deleteMany({
        where: { referralId: audit.receiverId, orderId: audit.orderId.toString() },
      });

      const inviter = await tx.member.upsert({
        where: { discordUserId: audit.workerReferralInviterId },
        create: { discordUserId: audit.workerReferralInviterId },
        update: {},
        select: { totalBalance: true, income: true },
      });

      const inviterBalanceBefore = DEC(inviter.totalBalance ?? 0);
      const inviterIncomeBefore = DEC(inviter.income ?? 0);
      const inviterBalanceAfter = inviterBalanceBefore.sub(amt);
      const inviterIncomeAfter = inviterIncomeBefore.sub(amt);

      await tx.member.update({
        where: { discordUserId: audit.workerReferralInviterId },
        data: {
          totalBalance: inviterBalanceAfter,
          income: inviterIncomeAfter,
        },
      });

      await recordIndividualTransaction(tx, {
        discordId: audit.workerReferralInviterId,
        thirdPartydiscordId: audit.receiverId,
        balanceBefore: inviterBalanceBefore,
        amountChange: amt,
        balanceAfter: inviterBalanceAfter,
        typeOfTransaction: '邀请提成撤销',
      });
    }

    await tx.revert.update({
      where: { id: revertRow.id },
      data: {
        status: 'SUCCESS',
        details: {
          payable: payable.toString(),
          netAmount: netAmount.toString(),
          heartGain,
          voucherIds,
        } as any,
      },
    });

    return {
      audit,
      payable,
      netAmount,
      heartGain,
    };
  });

  try {
    await syncSpentRolesForMember(result.audit.giverId);
    await syncSpentRolesForMember(result.audit.receiverId, { includeSpendRoles: false });
  } catch (err) {
    console.error('[revert-gift] sync roles failed', err);
  }

  // notifications (best-effort)
  try {
    const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
    if (client) {
      const giver = await client.users.fetch(result.audit.giverId).catch(() => null);
      const receiver = await client.users.fetch(result.audit.receiverId).catch(() => null);
      const refundText = Number(result.payable.toString()).toFixed(2);
      const workerNetText = Number(result.netAmount.toString()).toFixed(2);
      const giverName =
        giver?.username || (giver as any)?.displayName || result.audit.giverId;
      if (giver) {
        await giver.send(`你的一笔打赏已撤销，金额 ¥${refundText} 已返还。`).catch(() => {});
      }
      if (receiver) {
        await receiver
          .send(`有一笔打赏（老板 ${giverName}）已被撤销，金额 ¥${workerNetText} 已扣回。`)
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error('[revert-gift] notify failed', err);
  }

  return result;
}
