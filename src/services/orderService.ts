import prisma from '../db/prisma.js';
import { AccountProvider, Prisma, OrderStatus, PeiwanStatus, MemberStatus } from '@prisma/client';
import { round2, minutesBetweenCeil } from '../lib/money.js';
import { addMinutes, minutesBetweenFloor } from '../lib/time.js';
import { addHeart } from './heartService.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { consumeFlowBuff, consumeSpendBuff, getActiveCommissionBoost, getFlowBuffRemaining } from './buffService.js';
import { awardVipAdjustedLoyaltyPointsTx } from './loyaltyPointService.js';
import { evaluateAutoCommissionBuff, getAutoCommissionBoost } from './autoCommissionBuffService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';
import {
  applyJinleeWalletDeltaTx,
  ensureJinleeIdentityForDiscordTx,
  getJinleeWalletSnapshotTx,
  lockJinleeUserForUpdateTx,
  requireJinleeIdentityTx,
  resolveJinleeIdentityTx,
} from './jinleeAccountService.js';
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

async function resolveOrderHostIdentityTx(
  tx: Prisma.TransactionClient,
  order: { hostId?: string | null; hostJinleeId?: string | null }
) {
  if (order.hostJinleeId) {
    return requireJinleeIdentityTx(tx, order.hostJinleeId);
  }
  if (order.hostId) {
    return ensureJinleeIdentityForDiscordTx(tx, order.hostId);
  }
  throw new Error('Host missing');
}

function buildHostOrderWhere(identity: { jinleeId: string; discordUserId: string | null }) {
  if (identity.discordUserId) {
    return {
      OR: [{ hostJinleeId: identity.jinleeId }, { hostId: identity.discordUserId }],
    };
  }
  return { hostJinleeId: identity.jinleeId };
}

async function getWechatProgramOpenIdTx(
  tx: Prisma.TransactionClient,
  jinleeId: string,
): Promise<string | null> {
  const binding = await tx.accountBinding.findFirst({
    where: {
      jinleeId,
      provider: AccountProvider.WECHAT_MINIPROGRAM,
    },
    select: { providerUserId: true },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  });
  return binding?.providerUserId ?? null;
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

    const hostIdentity = await resolveOrderHostIdentityTx(tx, order);

    // host balance & unit price
    const host = await getJinleeWalletSnapshotTx(tx, hostIdentity);
    const unitPrice = new Prisma.Decimal(order.unitPrice ?? 0);

    // derive initial cutoff by balance considering concurrent orders
    const runningForHost = await tx.order.findMany({
      where: { ...buildHostOrderWhere(hostIdentity), status: OrderStatus.RUNNING },
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
      const minutesCoverable = host.totalBalance.div(perMinuteCost);
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
        hostJinleeId: hostIdentity.jinleeId,
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

    const baseStart = order.stopwatchStartAt ?? order.acceptedAt ?? order.createdAt ?? null;
    // Backward compatibility: old RUNNING orders may not have billableStartAt persisted.
    // In that case still honor the 5-minute free window from the session start.
    const billableAnchor = order.billableStartAt ?? (baseStart ? addMinutes(baseStart, 5) : null);
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

    const hostIdentity = await resolveOrderHostIdentityTx(tx, order);
    await lockJinleeUserForUpdateTx(tx, hostIdentity.jinleeId);
    const hostWallet = await getJinleeWalletSnapshotTx(tx, hostIdentity);
    const hostBalance = hostWallet.totalBalance;
    const runningReserved = await tx.order.aggregate({
      _sum: { chargedGross: true },
      where: { ...buildHostOrderWhere(hostIdentity), status: OrderStatus.RUNNING },
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

type RecalcResult = { order: any | null; ended: boolean; heartAmount?: number; hostId?: string | null; workerId?: string };

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
              select: {
                id: true,
                status: true,
                hostId: true,
                hostJinleeId: true,
                workerId: true,
                peiwanId: true,
                unitPrice: true,
                commissionRate: true,
                grossAmount: true,
                stopwatchStartAt: true,
                acceptedAt: true,
                createdAt: true,
                billableStartAt: true,
                chargedMinutes: true,
                chargedGross: true,
                cutoffAt: true,
              },
            });
            if (!order || order.status !== OrderStatus.RUNNING) {
              return { order, ended: false };
            }

            const now = new Date();
            const elapsedTotalMinutes = minutesBetweenCeil(order.stopwatchStartAt!, now);

            const hostIdentity = await resolveOrderHostIdentityTx(tx, order);
            await lockJinleeUserForUpdateTx(tx, hostIdentity.jinleeId);
            const hostWallet = await getJinleeWalletSnapshotTx(tx, hostIdentity);
            const runningForHost = await tx.order.findMany({
              where: { ...buildHostOrderWhere(hostIdentity), status: OrderStatus.RUNNING },
              select: { unitPrice: true, chargedGross: true },
            });
            const reserved = runningForHost.reduce(
              (sum, r) => (r.chargedGross ? sum.add(new Prisma.Decimal(r.chargedGross)) : sum),
              new Prisma.Decimal(0)
            );
            let hostBalance = hostWallet.totalBalance.sub(reserved);
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
    evaluateAutoCommissionBuff(result.workerId).catch((err) =>
      console.error('[recalcOrAutoEnd] auto commission eval failed', { orderId, err }),
    );
  }
  const totalDuration = Date.now() - outerStart;
  console.log('[recalcOrAutoEnd] duration', { orderId, txMs: txDuration, totalMs: totalDuration, ended: result.ended });
  return result;
}

export async function recalcAllOrdersForHost(hostId: string) {
  const hostIdentity = await resolveJinleeIdentityTx(prisma, hostId);
  const running = await prisma.order.findMany({
    where: hostIdentity
      ? { ...buildHostOrderWhere(hostIdentity), status: OrderStatus.RUNNING }
      : { hostId, status: OrderStatus.RUNNING },
    select: { id: true },
  });
  for (const o of running) {
    try {
      const { ended } = await recalcOrAutoEnd(o.id);
      if (ended) {
        // 通知统一由 timerService 触发，避免重复
      }
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
              select: {
                id: true,
                status: true,
                hostId: true,
                hostJinleeId: true,
                workerId: true,
                peiwanId: true,
                unitPrice: true,
                commissionRate: true,
                grossAmount: true,
                stopwatchStartAt: true,
                acceptedAt: true,
                createdAt: true,
                billableStartAt: true,
                chargedMinutes: true,
                chargedGross: true,
                cutoffAt: true,
                peiwan: { select: { totalEarn: true } },
                worker: { select: { commissionRate: true, totalBalance: true, income: true, recharge: true } },
                host: { select: { totalBalance: true, income: true, recharge: true } },
              },
            });
            if (!order) throw new Error('Order not running');
            // Idempotency guard: if订单已结束，直接返回现状
            if (order.status !== OrderStatus.RUNNING) return { order, heartAmount: undefined, hostId: order.hostId, workerId: order.workerId };
            const actorIdentity = await resolveJinleeIdentityTx(tx, byDiscordId);
            const isParticipant =
              order.hostId === byDiscordId
              || order.workerId === byDiscordId
              || (!!actorIdentity && !!order.hostJinleeId && order.hostJinleeId === actorIdentity.jinleeId);
            if (!isParticipant) throw new Error('Not participant');

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
    evaluateAutoCommissionBuff(result.workerId).catch((err) =>
      console.error('[endOrder] auto commission eval failed', { orderId, err }),
    );
  }
  // 通知统一由 timerService 触发，避免重复
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
  // Backward compatibility for legacy rows without billableStartAt.
  const billableStart = order.billableStartAt ?? addMinutes(stopwatchStart, 5);
  const billableMinutes = Math.max(0, minutesBetweenCeil(billableStart, endTime));

  const gross = round2(unitPrice.mul(billableMinutes).div(60));
  let payoutShare = new Prisma.Decimal(order.commissionRate ?? order.worker.commissionRate ?? 0.75);
  const manualBoost = await getActiveCommissionBoost(tx, order.workerId);
  const autoBoost = await getAutoCommissionBoost(tx, order.workerId, payoutShare);
  payoutShare = payoutShare.add(manualBoost).add(autoBoost);
  if (payoutShare.gt(1)) payoutShare = new Prisma.Decimal(1);
  const netToWorker = round2(gross.mul(payoutShare));
  const feeToPlatform = round2(gross.sub(netToWorker));

  await settle(tx, order, endTime, totalMinutes, billableMinutes, gross, netToWorker, feeToPlatform, payoutShare);

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
  feeToPlatform: Prisma.Decimal,
  payoutShare: Prisma.Decimal
) {
  await suppressRechargeNotifications(tx);

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

  const hostIdentity = await resolveOrderHostIdentityTx(tx, order);
  await lockJinleeUserForUpdateTx(tx, hostIdentity.jinleeId);
  const hostWallet = await getJinleeWalletSnapshotTx(tx, hostIdentity);
  const hostIncome = hostWallet.income;
  const hostRecharge = hostWallet.recharge;
  const hostBalanceBefore = hostWallet.totalBalance;
  let hostBalanceAfter = hostBalanceBefore;
  let hostFromIncome = new Prisma.Decimal(0);
  let hostFromRecharge = new Prisma.Decimal(0);
  let pointsAwarded = new Prisma.Decimal(0);

  const spendBonus =
    hostIdentity.discordUserId != null
      ? await consumeSpendBuff(tx, hostIdentity.discordUserId, gross)
      : { extra: new Prisma.Decimal(0), remaining: new Prisma.Decimal(0) };
  const spendRemainingBefore = spendBonus.extra.add(spendBonus.remaining);
  const totalSpentIncrement = gross.add(spendBonus.extra);
  let hostIndividualTxId: string | null = null;

  if (gross.gt(0)) {
    hostFromIncome = hostIncome.gte(gross) ? gross : hostIncome;
    hostFromRecharge = gross.sub(hostFromIncome);

    hostBalanceAfter = hostBalanceBefore.sub(gross);

    await applyJinleeWalletDeltaTx(tx, {
      jinleeId: hostIdentity.jinleeId,
      discordUserId: hostIdentity.discordUserId,
      incomeDelta: hostFromIncome.neg(),
      rechargeDelta: hostFromRecharge.neg(),
      totalBalanceDelta: gross.neg(),
      totalSpentDelta: totalSpentIncrement,
    });
    pointsAwarded = await awardVipAdjustedLoyaltyPointsTx(tx, hostIdentity, gross);

    const hostIndividualTx = await recordIndividualTransaction(tx, {
      discordId: hostIdentity.discordUserId,
      jinleeId: hostIdentity.jinleeId,
      thirdPartydiscordId: order.workerId,
      balanceBefore: hostBalanceBefore,
      amountChange: gross,
      balanceAfter: hostBalanceAfter,
      typeOfTransaction: '点单',
    });
    hostIndividualTxId = hostIndividualTx.transactionId;
  } else {
    await applyJinleeWalletDeltaTx(tx, {
      jinleeId: hostIdentity.jinleeId,
      discordUserId: hostIdentity.discordUserId,
      totalSpentDelta: totalSpentIncrement,
    });
  }

  const workerIdentity = await ensureJinleeIdentityForDiscordTx(tx, order.workerId);
  const workerWalletBefore = await getJinleeWalletSnapshotTx(tx, workerIdentity);
  const workerBalanceBefore = workerWalletBefore.totalBalance;
  const workerWalletAfter = await applyJinleeWalletDeltaTx(tx, {
    jinleeId: workerIdentity.jinleeId,
    discordUserId: workerIdentity.discordUserId,
    incomeDelta: netToWorker,
    totalBalanceDelta: netToWorker,
    offsetNegativeRechargeWithIncome: true,
  });
  const workerBalanceAfter = workerWalletAfter.totalBalance;
  await tx.member.update({
    where: { discordUserId: order.workerId },
    data: { status: MemberStatus.PEIWAN },
  });

  const flowRemainingBefore = order.peiwan ? await getFlowBuffRemaining(tx, order.workerId) : new Prisma.Decimal(0);
  const flowBonus = order.peiwan ? await consumeFlowBuff(tx, order.workerId, gross) : { extra: new Prisma.Decimal(0), remaining: new Prisma.Decimal(0) };
  const flowExtra = flowBonus.extra;

  if (order.peiwan) {
    await tx.pEIWAN.update({
      where: { PEIWANID: order.peiwanId },
      data: {
        totalEarn: new Prisma.Decimal(order.peiwan.totalEarn ?? 0).add(gross).add(flowExtra),
        balance: workerBalanceAfter,
      },
    });
  }

  const workerIndividualTx = await recordIndividualTransaction(tx, {
    discordId: workerIdentity.discordUserId,
    jinleeId: workerIdentity.jinleeId,
    thirdPartydiscordId: hostIdentity.discordUserId ?? 'SYSTEM',
    balanceBefore: workerBalanceBefore,
    amountChange: netToWorker,
    balanceAfter: workerBalanceAfter,
    typeOfTransaction: '点单',
  });

  const trans = await tx.transaction.create({
    data: {
      fromId: hostIdentity.discordUserId ?? null,
      toId: order.workerId,
      fromJinleeId: hostIdentity.jinleeId,
      toJinleeId: workerIdentity.jinleeId,
      amount: gross,
      feeAmount: feeToPlatform,
      netAmount: netToWorker,
    },
  });

  await tx.commission.create({
    data: {
      transactionId: trans.Transid,
      orderID: trans.orderID,
      fromId: hostIdentity.discordUserId ?? null,
      toId: order.workerId,
      fromJinleeId: hostIdentity.jinleeId,
      toJinleeId: workerIdentity.jinleeId,
      feeAmount: feeToPlatform,
    },
  });

  // Referral commission: inviter of host (LAOBAN) and inviter of worker (PEIWAN) both earn 1% of worker net
  const referralSummary = await grantReferralCommission(tx, {
    order,
    gross,
    netToWorker,
    endedAt,
  });

  const hostWechatOpenId = await getWechatProgramOpenIdTx(tx, hostIdentity.jinleeId);
  await tx.orderAudit.create({
    data: {
      orderId: order.id,
      paymentTransactionId: trans.Transid,
      transactionOrderId: trans.orderID,
      hostIndividualTransactionId: hostIndividualTxId ?? undefined,
      workerIndividualTransactionId: workerIndividualTx.transactionId,
      hostId: hostIdentity.discordUserId ?? null,
      hostJinleeId: hostIdentity.jinleeId,
      hostWechatOpenId,
      workerId: order.workerId,
      workerJinleeId: workerIdentity.jinleeId,
      peiwanId: order.peiwanId,
      gross,
      pointsEarned: pointsAwarded,
      feeAmount: feeToPlatform,
      netAmount: netToWorker,
      commissionRate: payoutShare,
      hostFromIncome,
      hostFromRecharge,
      spendBonusExtra: spendBonus.extra,
      spendRemainingBefore,
      flowBonusExtra: flowExtra,
      flowRemainingBefore,
      bossReferralInviterId: referralSummary.boss?.inviterId,
      bossReferralAmount: referralSummary.boss?.amount,
      workerReferralInviterId: referralSummary.worker?.inviterId,
      workerReferralAmount: referralSummary.worker?.amount,
      createdAt: endedAt,
    },
  });
}

type ReferralCommissionContext = {
  order: any;
  gross: Prisma.Decimal;
  netToWorker: Prisma.Decimal;
  endedAt: Date;
};

type ReferralAppliedSummary = {
  inviterId: string;
  inviteeId: string;
  amount: Prisma.Decimal;
};

async function grantReferralCommission(
  tx: Prisma.TransactionClient,
  ctx: ReferralCommissionContext
): Promise<{ boss: ReferralAppliedSummary | null; worker: ReferralAppliedSummary | null }> {
  const { order, gross, netToWorker, endedAt } = ctx;
  const REF_RATE = new Prisma.Decimal(0.01);
  let bossSummary: ReferralAppliedSummary | null = null;
  let workerSummary: ReferralAppliedSummary | null = null;

  // helper to pay and log
  const payReferral = async ({
    referral,
    amount,
  }: {
    referral: { inviterId: string; inviteeId: string; type: 'LAOBAN' | 'PEIWAN'; payoutCap: Prisma.Decimal | null };
    amount: Prisma.Decimal;
  }): Promise<ReferralAppliedSummary | null> => {
    if (amount.lte(0)) return null;

    if (referral.payoutCap != null) {
      const paidSoFar = await tx.referralPayout.aggregate({
        _sum: { amount: true },
        where: {
          referralId: referral.inviteeId,
          referral: { inviterId: referral.inviterId },
        },
      });
      const totalPaid = new Prisma.Decimal(paidSoFar._sum.amount ?? 0);
      const remaining = new Prisma.Decimal(referral.payoutCap).sub(totalPaid);
      if (remaining.lte(0)) return null;
      if (amount.gt(remaining)) {
        amount = remaining;
      }
    }
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
        return null;
      }
      throw err;
    }

    const inviter = await tx.member.upsert({
      where: { discordUserId: referral.inviterId },
      create: { discordUserId: referral.inviterId },
      update: {},
      select: { totalBalance: true, recharge: true },
    });
    const inviterIdentity = await ensureJinleeIdentityForDiscordTx(tx, referral.inviterId);

    const balanceBefore = new Prisma.Decimal(inviter.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(amount);

    await applyJinleeWalletDeltaTx(tx, {
      jinleeId: inviterIdentity.jinleeId,
      discordUserId: inviterIdentity.discordUserId,
      rechargeDelta: amount,
      totalBalanceDelta: amount,
    });

    await recordIndividualTransaction(tx, {
      discordId: referral.inviterId,
      jinleeId: inviterIdentity.jinleeId,
      thirdPartydiscordId: referral.inviteeId,
      balanceBefore,
      amountChange: amount,
      balanceAfter,
      typeOfTransaction: `邀请提成`,
      timeCreatedAt: endedAt,
    });

    return {
      inviterId: referral.inviterId,
      inviteeId: referral.inviteeId,
      amount,
    };
  };

  // boss side: 1% of worker net
  const bossReferral = order.hostId
    ? await tx.referral.findUnique({
        where: { inviteeId: order.hostId },
        select: { inviterId: true, inviteeId: true, type: true, payoutRate: true, payoutCap: true },
      })
    : null;
  if (bossReferral?.type === 'LAOBAN') {
    const amount = round2(netToWorker.mul(new Prisma.Decimal(bossReferral.payoutRate ?? REF_RATE)));
    bossSummary = await payReferral({
      referral: {
        inviterId: bossReferral.inviterId,
        inviteeId: bossReferral.inviteeId,
        type: 'LAOBAN',
        payoutCap: bossReferral.payoutCap,
      },
      amount,
    });
  }

  // worker side
  const workerReferral = await tx.referral.findUnique({
    where: { inviteeId: order.workerId },
    select: { inviterId: true, inviteeId: true, type: true, payoutRate: true, payoutCap: true },
  });
  if (workerReferral?.type === 'PEIWAN') {
    const amount = round2(netToWorker.mul(new Prisma.Decimal(workerReferral.payoutRate ?? REF_RATE)));
    workerSummary = await payReferral({
      referral: {
        inviterId: workerReferral.inviterId,
        inviteeId: workerReferral.inviteeId,
        type: 'PEIWAN',
        payoutCap: workerReferral.payoutCap,
      },
      amount,
    });
  }

  return { boss: bossSummary, worker: workerSummary };
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
        // 通知统一由 timerService 触发，避免重复
      }
    } catch (err) {
      console.error('[recoverRunningOrders] order', o.id, 'failed:', err);
    }
  }
}
