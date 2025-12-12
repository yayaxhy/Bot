import { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../db/prisma.js';

type TxLike = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
const COMMISSION_BOOST = new Prisma.Decimal(0.01); // +1%
const COMMISSION_DURATION_MS = 30 * DAY_MS;
const FLOW_EXTRA_CAP = new Prisma.Decimal(5000);
const FLOW_DURATION_MS = 30 * DAY_MS;

export async function applyCommissionBuff(
  client: TxLike,
  userId: string
): Promise<{ expiresAt: Date; boosted: boolean; commissionRate: Prisma.Decimal | null }> {
  const now = new Date();
  const active = await (client as any).commissionBuff.findFirst({
    where: { userId, expiresAt: { gt: now } },
    select: { expiresAt: true, boost: true },
  });

  // 如果已有未过期 buff，仅延长有效期，并确保 peiwan/member 费率同步到当前值（不再叠加比例）
  if (active?.expiresAt && active.expiresAt > now) {
    const base = active.expiresAt;
    const newExpires = new Date(base.getTime() + COMMISSION_DURATION_MS);
    const memberRateRow = await (client as any).member.findUnique({
      where: { discordUserId: userId },
      select: { commissionRate: true },
    });
    const peiwanRateRow = await (client as any).pEIWAN.findUnique({
      where: { discordUserId: userId },
      select: { commissionRate: true },
    });
    let targetRate = new Prisma.Decimal(
      memberRateRow?.commissionRate ?? peiwanRateRow?.commissionRate ?? 0
    );
    if (targetRate.gt(1)) targetRate = new Prisma.Decimal(1);

    await (client as any).member.updateMany({
      where: { discordUserId: userId },
      data: { commissionRate: targetRate },
    });
    await (client as any).pEIWAN.updateMany({
      where: { discordUserId: userId },
      data: { commissionRate: targetRate },
    });

    await (client as any).commissionBuff.update({
      where: { userId },
      data: { expiresAt: newExpires, boost: COMMISSION_BOOST },
    });
    return { expiresAt: newExpires, boosted: false, commissionRate: targetRate };
  }

  // 没有有效 buff：增加 1% 分成并记录有效期
  const member = await (client as any).member.findUnique({
    where: { discordUserId: userId },
    select: { commissionRate: true },
  });
  let newRate = new Prisma.Decimal(member?.commissionRate ?? 0).add(COMMISSION_BOOST);
  if (newRate.gt(1)) newRate = new Prisma.Decimal(1);

  await (client as any).member.update({
    where: { discordUserId: userId },
    data: { commissionRate: newRate },
  });
  await (client as any).pEIWAN.updateMany({
    where: { discordUserId: userId },
    data: { commissionRate: newRate },
  });

  const expiresAt = new Date(now.getTime() + COMMISSION_DURATION_MS);
  await (client as any).commissionBuff.upsert({
    where: { userId },
    create: { userId, boost: COMMISSION_BOOST, expiresAt },
    update: { boost: COMMISSION_BOOST, expiresAt },
  });

  return { expiresAt, boosted: true, commissionRate: newRate };
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
