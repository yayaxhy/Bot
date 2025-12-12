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
): Promise<{ expiresAt: Date }> {
  const rows = (await client.$queryRaw<
    { expires_at: Date | string | null }[]
  >`SELECT expires_at FROM commission_buff WHERE user_id = ${userId} LIMIT 1`) ?? [];
  const now = new Date();
  const currentExpires = rows[0]?.expires_at ? new Date(rows[0].expires_at) : null;
  const base = currentExpires && currentExpires > now ? currentExpires : now;
  const newExpires = new Date(base.getTime() + COMMISSION_DURATION_MS);

  await client.$executeRaw`
    INSERT INTO commission_buff (user_id, boost, expires_at, created_at, updated_at)
    VALUES (${userId}, ${COMMISSION_BOOST}, ${newExpires}, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET expires_at = ${newExpires},
          boost = ${COMMISSION_BOOST},
          updated_at = now()
  `;

  return { expiresAt: newExpires };
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
