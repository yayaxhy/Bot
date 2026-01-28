import prisma from '../db/prisma.js';
import { Prisma, OrderStatus, PeiwanStatus, MemberStatus } from '@prisma/client';
import { round2, minutesBetweenCeil } from '../lib/money.js';
import { addMinutes, minutesBetweenFloor } from '../lib/time.js';
import { addHeart } from './heartService.js';
import { notifyOrderEnded } from './orderNotificationService.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { consumeSpendBuff, getActiveCommissionBoost } from './buffService.js';
import { adjustLoyaltyPointsTx } from './loyaltyPointService.js';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library.js';
import { PrismaClientKnownRequestError as PrismaKnownError } from '@prisma/client/runtime/library.js';

// Give end-order transactions more time to complete to avoid P2028 timeout errors.
const TX_TIMEOUT_MS = 30000;
const DEADLOCK_CODE = '40P01';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetriableTimeout = (err: any) =>
  err instanceof PrismaKnownError && err.code === 'P2028';

async function withDeadlockRetries<T>(fn: () => Promise<T>, retries = 2, delayMs = 100): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const isDeadlock =
        (err instanceof PrismaKnownError && err.code === 'P2010' && (err as any)?.meta?.code === DEADLOCK_CODE) ||
        (err?.code === 'P2010' && err?.meta?.code === DEADLOCK_CODE);
      if (!isDeadlock || i === retries) throw err;
      await sleep(delayMs);
    }
  }
  // Unreachable
  throw new Error('withDeadlockRetries exhausted');
}

async function withTimeoutRetries<T>(fn: () => Promise<T>, retries = 1, delayMs = 50): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isRetriableTimeout(err) || i === retries) throw err;
      await sleep(delayMs);
    }
  }
  throw new Error('withTimeoutRetries exhausted');
}

// Prevent double settlement when multiple end requests land at once.
async function lockOrderForUpdate(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$executeRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
}

/** Accept an existing PENDING order and lock the peiwan busy */
export async function acceptOrder(orderId: string) {
  return prisma.$transaction(async (tx) => {
    await lockOrderForUpdate(tx, orderId);

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
        chargedMinutes: 0,
        chargedGross: 0,
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
  }, { timeout: TX_TIMEOUT_MS });
}

type ChargeResult = { charged: boolean; insufficient: boolean };

export async function chargePendingMinutes(orderId: string): Promise<ChargeResult> {
  return withDeadlockRetries(() => prisma.$transaction(async (tx) => {
    // Lock order first to keep lock ordering consistent with endOrder/recalc and avoid deadlocks.
    await lockOrderForUpdate(tx, orderId);

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        host: { select: { totalBalance: true } },
      },
    });
    if (!order || order.status !== OrderStatus.RUNNING) return { charged: false, insufficient: false };

    const billableAnchor =
      order.billableStartAt ?? order.stopwatchStartAt ?? order.acceptedAt ?? order.createdAt ?? null;
    if (!billableAnchor) return { charged: false, insufficient: false };

    const now = new Date();
    if (billableAnchor >= now) return { charged: false, insufficient: false };

    const elapsedBillable = minutesBetweenFloor(billableAnchor, now);
    const alreadyCharged = order.chargedMinutes ?? 0;
    const pendingMinutes = elapsedBillable - alreadyCharged;
    if (pendingMinutes <= 0) return { charged: false, insufficient: false };

    const unitPrice = new Prisma.Decimal(order.unitPrice ?? 0);
    if (unitPrice.lte(0)) return { charged: false, insufficient: false };
    const perMinute = round2(unitPrice.div(60));
    if (perMinute.lte(0)) return { charged: false, insufficient: false };

    // 读取最新余额（行锁），避免使用旧快照
    await tx.$queryRaw`SELECT 1 FROM "Member" WHERE "discordUserId" = ${order.hostId} FOR UPDATE`;
    const hostMember = await tx.member.findUnique({
      where: { discordUserId: order.hostId },
      select: { totalBalance: true },
    });
    const hostBalance = new Prisma.Decimal(hostMember?.totalBalance ?? 0);
    const runningReserved = await tx.order.aggregate({
      _sum: { chargedGross: true },
      where: { hostId: order.hostId, status: OrderStatus.RUNNING },
    });
    const reserved = new Prisma.Decimal(runningReserved._sum?.chargedGross ?? 0);
    let hostAvailable = hostBalance.sub(reserved);
    if (hostAvailable.lt(0)) hostAvailable = new Prisma.Decimal(0);
    const maxMinutesByBalance = hostAvailable.lte(0)
      ? 0
      : Math.floor(hostAvailable.div(perMinute).toNumber());
    const minutesToCharge = Math.min(pendingMinutes, maxMinutesByBalance);
    if (minutesToCharge <= 0) {
      return { charged: false, insufficient: true };
    }

    const gross = round2(perMinute.mul(minutesToCharge));
    if (gross.lte(0)) return { charged: false, insufficient: false };

    await tx.order.update({
      where: { id: orderId },
      data: {
        chargedMinutes: { increment: minutesToCharge },
        chargedGross: { increment: gross },
      },
    });

    return { charged: true, insufficient: minutesToCharge < pendingMinutes };
  }, { timeout: TX_TIMEOUT_MS }));
}

type RecalcResult = { order: any | null; ended: boolean; heartAmount?: number; hostId?: string; workerId?: string };

/** Recompute remaining minutes; auto-end if balance can’t cover next minute */
export async function recalcOrAutoEnd(orderId: string): Promise<RecalcResult> {
  const outerStart = Date.now();
  let txDuration = 0;

  const result = await withDeadlockRetries(
    () =>
      withTimeoutRetries(async () => {
        const txStart = Date.now();
        try {
          return await prisma.$transaction(async (tx) => {
            await lockOrderForUpdate(tx, orderId);

            const order = await tx.order.findUnique({
              where: { id: orderId },
              include: { host: true, worker: true, peiwan: true },
            });
            if (!order || order.status !== OrderStatus.RUNNING) {
              return { order, ended: false };
            }

            const now = new Date();
            const elapsedTotalMinutes = minutesBetweenCeil(order.stopwatchStartAt!, now);

            // 最新余额 + 预留已计费金额
            await tx.$queryRaw`SELECT 1 FROM "Member" WHERE "discordUserId" = ${order.hostId} FOR UPDATE`;
            const hostMember = await tx.member.findUnique({
              where: { discordUserId: order.hostId },
              select: { totalBalance: true },
            });
            const runningForHost = await tx.order.findMany({
              where: { hostId: order.hostId, status: OrderStatus.RUNNING },
              select: { id: true, unitPrice: true, chargedGross: true },
            });
            const reserved = runningForHost.reduce(
              (sum, r) => (r.chargedGross ? sum.add(new Prisma.Decimal(r.chargedGross)) : sum),
              new Prisma.Decimal(0)
            );
            let hostBalance = new Prisma.Decimal(hostMember?.totalBalance ?? 0).sub(reserved);
            if (hostBalance.lt(0)) hostBalance = new Prisma.Decimal(0);
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
                const ended = await endOrderInternal(tx, order, now);
                return { order: ended.order, ended: true, heartAmount: ended.heartAmount, hostId: order.hostId, workerId: order.workerId };
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
              const ended = await endOrderInternal(tx, order, now);
              return { order: ended.order, ended: true, heartAmount: ended.heartAmount, hostId: order.hostId, workerId: order.workerId };
            }

            const updated = await tx.order.update({
              where: { id: order.id },
              data: { lastRecalcAt: now, totalMinutes: elapsedTotalMinutes },
            });
            return { order: updated, ended: false };
          }, { timeout: TX_TIMEOUT_MS });
        } finally {
          txDuration = Date.now() - txStart;
        }
      }, 1, 50),
    1,
    50
  );

  // 如果在事务内结束了订单，把耗时操作移到事务外
  if (result.ended && result.heartAmount && result.hostId && result.workerId) {
    try {
      await addHeart(result.hostId, result.workerId, result.heartAmount);
    } catch (err) {
      console.error('[recalcOrAutoEnd] addHeart failed', { orderId, err });
    }
  }
  const totalDuration = Date.now() - outerStart;
  console.log('[recalcOrAutoEnd] duration', { orderId, txMs: txDuration, totalMs: totalDuration, ended: result.ended });
  return result;
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
  const outerStart = Date.now();
  let txDuration = 0;

  const result = await withDeadlockRetries(
    () =>
      withTimeoutRetries(async () => {
        const txStart = Date.now();
        try {
          return await prisma.$transaction(async (tx) => {
            await lockOrderForUpdate(tx, orderId);

            const order = await tx.order.findUnique({
              where: { id: orderId },
              include: { host: true, worker: true, peiwan: true },
            });
            if (!order) throw new Error('Order not running');
            // Idempotency guard: if订单已结束，直接返回现状
            if (order.status !== OrderStatus.RUNNING) return { order, heartAmount: undefined, hostId: order.hostId, workerId: order.workerId };
            if (order.hostId !== byDiscordId && order.workerId !== byDiscordId) throw new Error('Not participant');

            const ended = await endOrderInternal(tx, order, new Date());
            return { ...ended, hostId: order.hostId, workerId: order.workerId };
          }, { timeout: TX_TIMEOUT_MS });
        } finally {
          txDuration = Date.now() - txStart;
        }
      }, 1, 50),
    1,
    50
  );

  // 事务外执行耗时/非必须操作，缩短锁持有
  if (result.heartAmount && result.hostId && result.workerId) {
    try {
      await addHeart(result.hostId, result.workerId, result.heartAmount);
    } catch (err) {
      console.error('[endOrder] addHeart failed', { orderId, err });
    }
  }
  try {
    await notifyOrderEnded(orderId);
  } catch (err) {
    console.error('[endOrder] notifyOrderEnded failed', { orderId, err });
  }
  const totalDuration = Date.now() - outerStart;
  console.log('[endOrder] duration', { orderId, txMs: txDuration, totalMs: totalDuration });
  return result.order;
}

/** Settlement helper */
async function endOrderInternal(tx: Prisma.TransactionClient, order: any, endTime: Date) {
  const unitPrice = new Prisma.Decimal(order.unitPrice ?? 0);

  const stopwatchStart =
    order.stopwatchStartAt ?? order.acceptedAt ?? order.createdAt ?? endTime;
  const totalMinutes = minutesBetweenCeil(stopwatchStart, endTime);
  const billableStart = order.billableStartAt ?? stopwatchStart;
  const billableMinutes = Math.max(0, minutesBetweenCeil(billableStart, endTime));

  const gross = round2(unitPrice.mul(billableMinutes).div(60));
  let payoutShare = new Prisma.Decimal(order.commissionRate ?? order.worker.commissionRate ?? 0.75);
  const commissionBoost = await getActiveCommissionBoost(tx, order.workerId);
  payoutShare = payoutShare.add(commissionBoost);
  if (payoutShare.gt(1)) payoutShare = new Prisma.Decimal(1);
  const netToWorker = round2(gross.mul(payoutShare));
  const feeToPlatform = round2(gross.sub(netToWorker));

  await settle(tx, order, endTime, totalMinutes, billableMinutes, gross, netToWorker, feeToPlatform);

  await tx.pEIWAN.update({ where: { PEIWANID: order.peiwanId }, data: { status: PeiwanStatus.free } });
  await tx.workerLock.deleteMany({ where: { workerId: order.workerId } });

  const heartAmount = Number((order.grossAmount ?? gross).toNumber?.() ?? gross.toNumber());

  const updated = await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.ENDED } });
  return { order: updated, heartAmount };
}

async function settle(
  tx: Prisma.TransactionClient,
  order: any,
  endedAt: Date,
  totalMinutes: number,
  billableMinutes: number,
  gross: Prisma.Decimal,
  netToWorker: Prisma.Decimal,
  feeToPlatform: Prisma.Decimal
) {
  await tx.order.update({
    where: { id: order.id },
    data: {
      endedAt,
      totalMinutes,
      grossAmount: gross,
      netAmount: netToWorker,
      chargedMinutes: billableMinutes,
      chargedGross: gross,
    },
  });

  // 串行化老板扣款，防止并发结算读取相同余额
  await tx.$queryRaw`SELECT 1 FROM "Member" WHERE "discordUserId" = ${order.hostId} FOR UPDATE`;

  const hostAccount = await tx.member.findUnique({
    where: { discordUserId: order.hostId },
    select: { income: true, recharge: true, totalBalance: true },
  });
  if (!hostAccount) throw new Error('Host missing');

  const hostIncome = new Prisma.Decimal(hostAccount.income ?? 0);
  const hostRecharge = new Prisma.Decimal(hostAccount.recharge ?? 0);
  const hostBalanceBefore = new Prisma.Decimal(hostAccount.totalBalance ?? 0);
  let hostBalanceAfter = hostBalanceBefore;
  const spendBonus = await consumeSpendBuff(tx, order.hostId, gross);
  const totalSpentIncrement = gross.add(spendBonus.extra);

  if (gross.gt(0)) {
    const fromIncome = hostIncome.gte(gross) ? gross : hostIncome;
    const fromRecharge = gross.sub(fromIncome);

    hostBalanceAfter = hostBalanceBefore.sub(gross);

    await tx.member.update({
      where: { discordUserId: order.hostId },
      data: {
        income: { decrement: fromIncome },
        recharge: { decrement: fromRecharge },
        totalBalance: { decrement: gross },
        totalSpent: { increment: totalSpentIncrement },
      },
    });
    await adjustLoyaltyPointsTx(tx, order.hostId, gross);

    await recordIndividualTransaction(tx, {
      discordId: order.hostId,
      thirdPartydiscordId: order.workerId,
      balanceBefore: hostBalanceBefore,
      amountChange: gross,
      balanceAfter: hostBalanceAfter,
      typeOfTransaction: '点单',
    });
  } else {
    await tx.member.update({
      where: { discordUserId: order.hostId },
      data: {
        totalSpent: { increment: totalSpentIncrement },
      },
    });
  }

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

  // Referral commission: inviter of host (LAOBAN) earns 1% of gross; inviter of worker (PEIWAN) earns 1% of worker net
  await grantReferralCommission(tx, {
    order,
    gross,
    netToWorker,
    endedAt,
  });
}

type ReferralCommissionContext = {
  order: any;
  gross: Prisma.Decimal;
  netToWorker: Prisma.Decimal;
  endedAt: Date;
};

async function grantReferralCommission(
  tx: Prisma.TransactionClient,
  ctx: ReferralCommissionContext
) {
  const { order, gross, netToWorker, endedAt } = ctx;
  const REF_RATE = new Prisma.Decimal(0.01);

  // helper to pay and log
  const payReferral = async ({
    referral,
    amount,
    baseLabel,
  }: {
    referral: { inviterId: string; inviteeId: string; type: 'LAOBAN' | 'PEIWAN' };
    amount: Prisma.Decimal;
    baseLabel: string;
  }) => {
    if (amount.lte(0)) return;
    try {
      await tx.referralPayout.create({
        data: {
          referralId: referral.inviteeId,
          orderId: order.id,
          amount,
        },
      });
    } catch (err) {
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // duplicate (already paid)
        return;
      }
      throw err;
    }

    const inviter = await tx.member.upsert({
      where: { discordUserId: referral.inviterId },
      create: { discordUserId: referral.inviterId },
      update: {},
      select: { totalBalance: true, income: true, recharge: true },
    });

    const balanceBefore = new Prisma.Decimal(inviter.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(amount);

    await tx.member.update({
      where: { discordUserId: referral.inviterId },
      data: {
        income: { increment: amount },
        totalBalance: { increment: amount },
      },
    });

    await recordIndividualTransaction(tx, {
      discordId: referral.inviterId,
      thirdPartydiscordId: referral.inviteeId,
      balanceBefore,
      amountChange: amount,
      balanceAfter,
      typeOfTransaction: `邀请提成`,
      timeCreatedAt: endedAt,
    });
  };

  // boss side
  const bossReferral = await tx.referral.findUnique({
    where: { inviteeId: order.hostId },
    select: { inviterId: true, inviteeId: true, type: true },
  });
  if (bossReferral?.type === 'LAOBAN') {
    const amount = round2(gross.mul(REF_RATE));
    await payReferral({
      referral: {
        inviterId: bossReferral.inviterId,
        inviteeId: bossReferral.inviteeId,
        type: 'LAOBAN',
      },
      amount,
      baseLabel: '老板1%',
    });
  }

  // worker side
  const workerReferral = await tx.referral.findUnique({
    where: { inviteeId: order.workerId },
    select: { inviterId: true, inviteeId: true, type: true },
  });
  if (workerReferral?.type === 'PEIWAN') {
    const amount = round2(netToWorker.mul(REF_RATE));
    await payReferral({
      referral: {
        inviterId: workerReferral.inviterId,
        inviteeId: workerReferral.inviteeId,
        type: 'PEIWAN',
      },
      amount,
      baseLabel: '陪玩1%',
    });
  }
}

/** Recover running orders after restart: recompute balance/cutoff and auto-end if不足 */
export async function recoverRunningOrders(): Promise<void> {
  const running = await prisma.order.findMany({
    where: { status: OrderStatus.RUNNING },
    select: { id: true },
  });
  for (const o of running) {
    try {
      const { ended } = await recalcOrAutoEnd(o.id);
      if (ended) {
        await notifyOrderEnded(o.id);
      }
    } catch (err) {
      console.error('[recoverRunningOrders] order', o.id, 'failed:', err);
    }
  }
}
