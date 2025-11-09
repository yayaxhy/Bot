import prisma from '../db/prisma.js';
import { Prisma, OrderStatus, PeiwanStatus, MemberStatus } from '@prisma/client';
import { D, round2, minutesBetweenCeil } from '../lib/money.js';
import { addMinutes } from '../lib/time.js';
import { addHeart } from './heartService.js';
import { notifyOrderEnded } from './orderNotificationService.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';

/** Accept an existing PENDING order and lock the peiwan busy */
export async function acceptOrder(orderId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { peiwan: true, worker: true, host: true },
    });
    if (!order) throw new Error('Order not found');
    if (order.status !== OrderStatus.PENDING) throw new Error('Order not pending');

    // gate busy
    const pw = await tx.pEIWAN.findUnique({
      where: { PEIWANID: order.peiwanId },
      select: { status: true, discordUserId: true },
    });
    if (!pw) throw new Error('PEIWAN missing');
    if (pw.status !== PeiwanStatus.free) throw new Error('该陪玩繁忙');

    // host balance & unit price
    const host = await tx.member.findUnique({ where: { discordUserId: order.hostId }, select: { totalBalance: true } });
    if (!host) throw new Error('Host missing');
    const unitPrice = new Prisma.Decimal(order.unitPrice ?? 0);

    // derive initial cutoff by balance considering concurrent orders
    const runningForHost = await tx.order.findMany({
      where: { hostId: order.hostId, status: OrderStatus.RUNNING },
      select: { unitPrice: true },
    });
    let totalHourlyCost = new Prisma.Decimal(order.unitPrice ?? 0);
    for (const r of runningForHost) {
      if (r.unitPrice) totalHourlyCost = totalHourlyCost.add(new Prisma.Decimal(r.unitPrice));
    }
    const perMinuteCost = totalHourlyCost.div(60);

    let maxMinutesAtAccept: number | null = null;
    let cutoffAt: Date | null = null;
    if (perMinuteCost.gt(0)) {
      const minutesCoverable = new Prisma.Decimal(host.totalBalance ?? 0).div(perMinuteCost);
      const remainMinutes = Math.floor(minutesCoverable.toNumber());
      if (remainMinutes > 0) {
        maxMinutesAtAccept = remainMinutes;
        cutoffAt = addMinutes(new Date(), remainMinutes);
      }
    }

    const now = new Date();
    const billableStartAt = addMinutes(now, 5);

    // snapshot worker payout share (commissionRate = share user receives)
    const worker = await tx.member.findUnique({ where: { discordUserId: order.workerId }, select: { commissionRate: true } });
    if (!worker) throw new Error('Worker missing');

    await tx.member.update({
      where: { discordUserId: order.workerId },
      data: { status: MemberStatus.PEIWAN },
    });

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.RUNNING,
        acceptedAt: now,
        stopwatchStartAt: now,
        billableStartAt,
        commissionRate: worker.commissionRate,
        maxMinutesAtAccept,
        cutoffAt,
      },
    });

    await tx.pEIWAN.update({
      where: { PEIWANID: order.peiwanId },
      data: { status: PeiwanStatus.busy },
    });

    await tx.workerLock.upsert({
      where: { workerId: order.workerId },
      update: { orderId: order.id },
      create: { workerId: order.workerId, orderId: order.id },
    });

    return updated;
  });
}

type RecalcResult = { order: any | null; ended: boolean };

/** Recompute remaining minutes; auto-end if balance can’t cover next minute */
export async function recalcOrAutoEnd(orderId: string): Promise<RecalcResult> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { host: true, worker: true, peiwan: true },
    });
    if (!order || order.status !== OrderStatus.RUNNING) {
      return { order, ended: false };
    }

    const now = new Date();
    const elapsedTotalMinutes = minutesBetweenCeil(order.stopwatchStartAt!, now);

    const hostBalance = new Prisma.Decimal(order.host.totalBalance ?? 0);

    const runningForHost = await tx.order.findMany({
      where: { hostId: order.hostId, status: OrderStatus.RUNNING },
      select: { id: true, unitPrice: true },
    });
    let totalHourlyCost = new Prisma.Decimal(0);
    for (const r of runningForHost) {
      if (r.unitPrice) {
        const price = new Prisma.Decimal(r.unitPrice);
        if (price.gt(0)) totalHourlyCost = totalHourlyCost.add(price);
      }
    }
    const perMinuteCost = totalHourlyCost.div(60);

    if (perMinuteCost.gt(0)) {
      const minutesCoverable = hostBalance.div(perMinuteCost);
      if (minutesCoverable.lt(2)) {
        const endedOrder = await endOrderInternal(tx, order, now);
        return { order: endedOrder, ended: true };
      }
      const remainByBalance = Math.floor(minutesCoverable.toNumber());
      const newCutoff = addMinutes(now, remainByBalance);
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { lastRecalcAt: now, totalMinutes: elapsedTotalMinutes, cutoffAt: newCutoff },
      });
      return { order: updated, ended: false };
    }

    if (hostBalance.lte(0)) {
      const endedOrder = await endOrderInternal(tx, order, now);
      return { order: endedOrder, ended: true };
    }

    const updated = await tx.order.update({
      where: { id: order.id },
      data: { lastRecalcAt: now, totalMinutes: elapsedTotalMinutes },
    });
    return { order: updated, ended: false };
  });
}

export async function recalcAllOrdersForHost(hostId: string) {
  const running = await prisma.order.findMany({
    where: { hostId, status: OrderStatus.RUNNING },
    select: { id: true },
  });
  for (const o of running) {
    try {
      const { ended } = await recalcOrAutoEnd(o.id);
      if (ended) await notifyOrderEnded(o.id);
    } catch (err) {
      console.error('[recalcAllOrdersForHost] order', o.id, 'failed:', err);
    }
  }
}

/** End an order (host or worker) */
export async function endOrder(orderId: string, byDiscordId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { host: true, worker: true, peiwan: true },
    });
    if (!order || order.status !== OrderStatus.RUNNING) throw new Error('Order not running');
    if (order.hostId !== byDiscordId && order.workerId !== byDiscordId) throw new Error('Not participant');

    return endOrderInternal(tx, order, new Date());
  });
}

/** Settlement helper */
async function endOrderInternal(tx: Prisma.TransactionClient, order: any, endTime: Date) {
  const unitPrice = new Prisma.Decimal(order.unitPrice ?? 0);

  const totalMinutes = minutesBetweenCeil(order.stopwatchStartAt!, endTime);
  const billableStart = order.billableStartAt ?? order.stopwatchStartAt!;
  const billableMinutes = Math.max(0, minutesBetweenCeil(billableStart, endTime));

  const gross = round2(unitPrice.mul(billableMinutes).div(60));
  const payoutShare = new Prisma.Decimal(order.commissionRate ?? order.worker.commissionRate ?? 0.75);
  const netToWorker = round2(gross.mul(payoutShare));
  const feeToPlatform = round2(gross.sub(netToWorker));

  const hostBalance = new Prisma.Decimal(order.host.totalBalance);
  if (hostBalance.lt(gross)) {
    const cappedGross = hostBalance;
    const cappedNet   = round2(cappedGross.mul(payoutShare));
    const cappedFee   = round2(cappedGross.sub(cappedNet));
    await settle(tx, order, endTime, totalMinutes, cappedGross, cappedNet, cappedFee);
  } else {
    await settle(tx, order, endTime, totalMinutes, gross, netToWorker, feeToPlatform);
  }

  await tx.pEIWAN.update({ where: { PEIWANID: order.peiwanId }, data: { status: PeiwanStatus.free } });
  await tx.workerLock.deleteMany({ where: { workerId: order.workerId } });

  await addHeart(order.hostId, order.workerId, Number((order.grossAmount ?? gross).toNumber?.() ?? gross.toNumber()));

  return tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.ENDED } });
}

async function settle(
  tx: Prisma.TransactionClient,
  order: any,
  endedAt: Date,
  totalMinutes: number,
  gross: Prisma.Decimal,
  netToWorker: Prisma.Decimal,
  feeToPlatform: Prisma.Decimal
) {
  await tx.order.update({
    where: { id: order.id },
    data: { endedAt, totalMinutes, grossAmount: gross, netAmount: netToWorker },
  });

  const hostAccount = await tx.member.findUnique({
    where: { discordUserId: order.hostId },
    select: { income: true, recharge: true, totalBalance: true },
  });
  if (!hostAccount) throw new Error('Host missing');

  let hostSplit;
  try {
    hostSplit = splitIncomeRecharge(
      new Prisma.Decimal(hostAccount.income ?? 0),
      new Prisma.Decimal(hostAccount.recharge ?? 0),
      gross
    );
  } catch (err: any) {
    if (err?.message === 'INSUFFICIENT_FUNDS') {
      throw new Error('余额不足，无法完成结算。');
    }
    throw err;
  }

  await tx.member.update({
    where: { discordUserId: order.hostId },
    data: {
      income: { decrement: hostSplit.fromIncome },
      recharge: { decrement: hostSplit.fromRecharge },
      totalBalance: { decrement: gross },
      totalSpent: { increment: gross },
    },
  });

  await recordIndividualTransaction(tx, {
    discordId: order.hostId,
    thirdPartydiscordId: order.workerId,
    balanceBefore: hostSplit.totalBefore,
    amountChange: gross,
    balanceAfter: hostSplit.totalAfter,
    typeOfTransaction: '点单',
  });

  const workerAccount = await tx.member.findUnique({
    where: { discordUserId: order.workerId },
    select: { income: true, recharge: true, totalBalance: true },
  });
  if (!workerAccount) throw new Error('Worker missing');

  const workerBalanceBefore = new Prisma.Decimal(workerAccount.totalBalance ?? 0);
  const workerBalanceAfter = workerBalanceBefore.add(netToWorker);

  await tx.member.update({
    where: { discordUserId: order.workerId },
    data: {
      income: { increment: netToWorker },
      totalBalance: { increment: netToWorker },
      status: MemberStatus.PEIWAN,
    },
  });

  if (order.peiwan) {
    await tx.pEIWAN.update({
      where: { PEIWANID: order.peiwanId },
      data: {
        totalEarn: new Prisma.Decimal(order.peiwan.totalEarn ?? 0).add(gross),
        balance: workerBalanceAfter,
      },
    });
  }

  await recordIndividualTransaction(tx, {
    discordId: order.workerId,
    thirdPartydiscordId: order.hostId,
    balanceBefore: workerBalanceBefore,
    amountChange: netToWorker,
    balanceAfter: workerBalanceAfter,
    typeOfTransaction: '点单',
  });

  const trans = await tx.transaction.create({
    data: {
      fromId: order.hostId,
      toId: order.workerId,
      amount: gross,
      feeAmount: feeToPlatform,
      netAmount: netToWorker,
    },
  });

  await tx.commission.create({
    data: {
      transactionId: trans.Transid,
      orderID: trans.orderID,
      fromId: order.hostId,
      toId: order.workerId,
      feeAmount: feeToPlatform,
    },
  });
}
