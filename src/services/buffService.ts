import { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../db/prisma.js';

type TxLike = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
const COMMISSION_BOOST = new Prisma.Decimal(0.01); // +1%
const COMMISSION_DURATION_MS = 30 * DAY_MS;
const FLOW_EXTRA_CAP = new Prisma.Decimal(5000);
const FLOW_DURATION_MS = 30 * DAY_MS;
const SPEND_EXTRA_CAP = new Prisma.Decimal(5000);
const SPEND_DURATION_MS = 30 * DAY_MS;

const COMMISSION_WATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COMMISSION_CLEANUP_BATCH = 50;
let commissionCleanupRunning = false;

export async function applyCommissionBuff(
  client: TxLike,
  userId: string
): Promise<{ expiresAt: Date; boosted: boolean; commissionRate: Prisma.Decimal | null }> {
  const now = new Date();
  const active = await (client as any).commissionBuff.findFirst({
    where: { userId, expiresAt: { gt: now } },
    select: { expiresAt: true, boost: true },
  });

  // 如果已有未过期 buff，仅延长有效期
  if (active?.expiresAt && active.expiresAt > now) {
    const base = active.expiresAt;
    const newExpires = new Date(base.getTime() + COMMISSION_DURATION_MS);
    await (client as any).commissionBuff.update({
      where: { userId },
      data: { expiresAt: newExpires, boost: COMMISSION_BOOST },
    });
    return { expiresAt: newExpires, boosted: false, commissionRate: null };
  }

  // 没有有效 buff：仅记录有效期与 boost（结算时读取 commission_buff 叠加）
  const expiresAt = new Date(now.getTime() + COMMISSION_DURATION_MS);
  await (client as any).commissionBuff.upsert({
    where: { userId },
    create: { userId, boost: COMMISSION_BOOST, expiresAt },
    update: { boost: COMMISSION_BOOST, expiresAt },
  });

  return { expiresAt, boosted: true, commissionRate: null };
}

async function cleanupExpiredCommissionBuffs(batchSize: number): Promise<number> {
  const now = new Date();
  const expired = await (prisma as any).commissionBuff.findMany({
    where: { expiresAt: { lte: now } },
    select: { userId: true, boost: true },
    take: batchSize,
  });
  if (!expired.length) return 0;

  for (const row of expired) {
    await prisma.$transaction(async (tx) => {
      await (tx as any).commissionBuff.delete({ where: { userId: row.userId } });
    });
  }

  return expired.length;
}

export function startCommissionBuffWatcher() {
  const run = async () => {
    if (commissionCleanupRunning) return;
    commissionCleanupRunning = true;
    try {
      // 逐批处理直到没有过期记录
      while (true) {
        const processed = await cleanupExpiredCommissionBuffs(COMMISSION_CLEANUP_BATCH);
        if (processed === 0) break;
      }
    } catch (err) {
      console.error('[commission-buff] cleanup failed', err);
    } finally {
      commissionCleanupRunning = false;
    }
  };

  // 立即跑一次，然后周期性清理
  run().catch(() => {});
  setInterval(run, COMMISSION_WATCH_INTERVAL_MS);
}

export async function getActiveCommissionBoost(
  client: TxLike,
  userId: string
): Promise<Prisma.Decimal> {
  const rows = (await client.$queryRaw<
    { boost: Prisma.Decimal; expires_at: Date | string | null }[]
  >`SELECT boost, expires_at FROM commission_buff WHERE user_id = ${userId} AND expires_at > now() LIMIT 1`) ?? [];
  if (!rows.length) return new Prisma.Decimal(0);
  const boost = new Prisma.Decimal(rows[0].boost ?? 0);
  if (boost.lt(0)) return new Prisma.Decimal(0);
  return boost;
}

export async function applyFlowBuff(
  client: TxLike,
  userId: string
): Promise<{ expiresAt: Date; remaining: Prisma.Decimal }> {
  const rows = (await client.$queryRaw<
    { remaining_extra: Prisma.Decimal; expires_at: Date | string | null }[]
  >`SELECT remaining_extra, expires_at FROM flow_buff WHERE user_id = ${userId} LIMIT 1`) ?? [];
  const now = new Date();
  const currentExpires = rows[0]?.expires_at ? new Date(rows[0].expires_at) : null;
  const base = currentExpires && currentExpires > now ? currentExpires : now;
  const newExpires = new Date(base.getTime() + FLOW_DURATION_MS);
  const existingRemaining = new Prisma.Decimal(rows[0]?.remaining_extra ?? 0);
  const newRemaining = existingRemaining.add(FLOW_EXTRA_CAP);

  await client.$executeRaw`
    INSERT INTO flow_buff (user_id, remaining_extra, expires_at, created_at, updated_at)
    VALUES (${userId}, ${newRemaining}, ${newExpires}, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET remaining_extra = ${newRemaining},
          expires_at = ${newExpires},
          updated_at = now()
  `;

  return { expiresAt: newExpires, remaining: newRemaining };
}

export async function applySpendBuff(
  client: TxLike,
  userId: string
): Promise<{ expiresAt: Date; remaining: Prisma.Decimal }> {
  const rows = (await client.$queryRaw<
    { remaining_extra: Prisma.Decimal; expires_at: Date | string | null }[]
  >`SELECT remaining_extra, expires_at FROM spend_buff WHERE user_id = ${userId} LIMIT 1`) ?? [];
  const now = new Date();
  const currentExpires = rows[0]?.expires_at ? new Date(rows[0].expires_at) : null;
  const base = currentExpires && currentExpires > now ? currentExpires : now;
  const newExpires = new Date(base.getTime() + SPEND_DURATION_MS);
  const existingRemaining = new Prisma.Decimal(rows[0]?.remaining_extra ?? 0);
  const newRemaining = existingRemaining.add(SPEND_EXTRA_CAP);

  await client.$executeRaw`
    INSERT INTO spend_buff (user_id, remaining_extra, expires_at, created_at, updated_at)
    VALUES (${userId}, ${newRemaining}, ${newExpires}, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET remaining_extra = ${newRemaining},
          expires_at = ${newExpires},
          updated_at = now()
  `;

  return { expiresAt: newExpires, remaining: newRemaining };
}

export async function consumeFlowBuff(
  client: TxLike,
  userId: string,
  gross: Prisma.Decimal
): Promise<{ extra: Prisma.Decimal; remaining: Prisma.Decimal }> {
  const rows = (await client.$queryRaw<
    { remaining_extra: Prisma.Decimal; expires_at: Date | string | null }[]
  >`SELECT remaining_extra, expires_at FROM flow_buff WHERE user_id = ${userId} AND expires_at > now() LIMIT 1`) ?? [];
  if (!rows.length) return { extra: new Prisma.Decimal(0), remaining: new Prisma.Decimal(0) };
  const remaining = new Prisma.Decimal(rows[0].remaining_extra ?? 0);
  if (remaining.lte(0)) return { extra: new Prisma.Decimal(0), remaining };

  const extra = remaining.lt(gross) ? remaining : gross;
  const remainingAfter = remaining.sub(extra);

  await client.$executeRaw`
    UPDATE flow_buff
    SET remaining_extra = ${remainingAfter}, updated_at = now()
    WHERE user_id = ${userId}
  `;

  return { extra, remaining: remainingAfter };
}

export async function consumeSpendBuff(
  client: TxLike,
  userId: string,
  amount: Prisma.Decimal
): Promise<{ extra: Prisma.Decimal; remaining: Prisma.Decimal }> {
  const rows = (await client.$queryRaw<
    { remaining_extra: Prisma.Decimal; expires_at: Date | string | null }[]
  >`SELECT remaining_extra, expires_at FROM spend_buff WHERE user_id = ${userId} AND expires_at > now() LIMIT 1`) ?? [];
  if (!rows.length) return { extra: new Prisma.Decimal(0), remaining: new Prisma.Decimal(0) };
  const remaining = new Prisma.Decimal(rows[0].remaining_extra ?? 0);
  if (remaining.lte(0)) return { extra: new Prisma.Decimal(0), remaining };

  const extra = remaining.lt(amount) ? remaining : amount;
  const remainingAfter = remaining.sub(extra);

  await client.$executeRaw`
    UPDATE spend_buff
    SET remaining_extra = ${remainingAfter}, updated_at = now()
    WHERE user_id = ${userId}
  `;

  return { extra, remaining: remainingAfter };
}

export async function getFlowBuffRemaining(
  client: TxLike,
  userId: string
): Promise<Prisma.Decimal> {
  const rows = (await client.$queryRaw<
    { remaining_extra: Prisma.Decimal; expires_at: Date | string | null }[]
  >`SELECT remaining_extra, expires_at FROM flow_buff WHERE user_id = ${userId} AND expires_at > now() LIMIT 1`) ?? [];
  if (!rows.length) return new Prisma.Decimal(0);
  return new Prisma.Decimal(rows[0].remaining_extra ?? 0);
}

export async function getSpendBuffRemaining(
  client: TxLike,
  userId: string
): Promise<Prisma.Decimal> {
  const rows = (await client.$queryRaw<
    { remaining_extra: Prisma.Decimal; expires_at: Date | string | null }[]
  >`SELECT remaining_extra, expires_at FROM spend_buff WHERE user_id = ${userId} AND expires_at > now() LIMIT 1`) ?? [];
  if (!rows.length) return new Prisma.Decimal(0);
  return new Prisma.Decimal(rows[0].remaining_extra ?? 0);
}
