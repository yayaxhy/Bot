import { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../db/prisma.js';

type TxLike = PrismaClient | Prisma.TransactionClient;

export const AUTO_COMMISSION_TARGET_SHARE = new Prisma.Decimal(0.91);
export const AUTO_COMMISSION_THRESHOLD = new Prisma.Decimal(12000);
export const AUTO_COMMISSION_WINDOW_DAYS = 30;
export const AUTO_COMMISSION_ACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const AUTO_COMMISSION_INCOME_TYPES = ['点单', '打赏', '红包收入', '订单撤销', '打赏撤销'] as const;

const toDecimal = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

const getThresholdBucket = (amount: Prisma.Decimal) => {
  const numeric = amount.div(AUTO_COMMISSION_THRESHOLD).toNumber();
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
};

const parseTierExpiries = (value: Prisma.JsonValue | null | undefined) => {
  const map = new Map<number, Date>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return map;

  for (const [tierRaw, expiryRaw] of Object.entries(value as Record<string, unknown>)) {
    const tier = Number.parseInt(tierRaw, 10);
    if (!Number.isInteger(tier) || tier < 1) continue;
    if (typeof expiryRaw !== 'string') continue;
    const expiry = new Date(expiryRaw);
    if (Number.isNaN(expiry.getTime())) continue;
    map.set(tier, expiry);
  }
  return map;
};

const serializeTierExpiries = (map: Map<number, Date>): Prisma.InputJsonObject => {
  const obj: Record<string, string> = {};
  for (const [tier, expiry] of Array.from(map.entries()).sort((a, b) => a[0] - b[0])) {
    obj[String(tier)] = expiry.toISOString();
  }
  return obj;
};

const resolveTierActiveUntil = (map: Map<number, Date>, tier: number, now: Date) => {
  if (tier < 1) return null;
  const expiry = map.get(tier);
  if (!expiry || expiry <= now) return null;
  return expiry;
};

export function getAutoCommissionWindow(now = new Date()) {
  const utcStartOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const windowStart = new Date(utcStartOfToday.getTime() - (AUTO_COMMISSION_WINDOW_DAYS - 1) * DAY_MS);
  return { windowStart, windowEnd: now };
}

export async function computeAutoCommissionIncome(
  tx: TxLike,
  discordUserId: string,
  now = new Date(),
) {
  const { windowStart, windowEnd } = getAutoCommissionWindow(now);
  const rows = await tx.individualTransaction.findMany({
    where: {
      discordId: discordUserId,
      timeCreatedAt: { gte: windowStart, lte: windowEnd },
      typeOfTransaction: { in: [...AUTO_COMMISSION_INCOME_TYPES] },
    },
    select: {
      balanceBefore: true,
      balanceAfter: true,
    },
  });

  const amount = rows.reduce((sum, row) => {
    const before = toDecimal(row.balanceBefore ?? 0);
    const after = toDecimal(row.balanceAfter ?? 0);
    return sum.add(after.sub(before));
  }, new Prisma.Decimal(0));

  return { amount, windowStart, windowEnd };
}

export async function evaluateAutoCommissionBuff(userId: string, now = new Date()) {
  return evaluateAutoCommissionBuffWithReason(userId, 'income', now);
}

export async function evaluateAutoCommissionBuffWithReason(
  userId: string,
  reason: 'income' | 'revert' | 'manual',
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const peiwan = await tx.pEIWAN.findUnique({
      where: { discordUserId: userId },
      select: { discordUserId: true },
    });
    if (!peiwan) {
      await tx.autoCommissionBuff.deleteMany({ where: { userId } });
      const { windowStart, windowEnd } = getAutoCommissionWindow(now);
      return {
        userId,
        amount: new Prisma.Decimal(0),
        threshold: AUTO_COMMISSION_THRESHOLD,
        windowStart,
        windowEnd,
        activeUntil: null as Date | null,
        qualified: false,
      };
    }

    const existing = await tx.autoCommissionBuff.findUnique({
      where: { userId },
      select: { activeUntil: true, lastQualifiedAt: true, currentAmount: true, tierExpiries: true },
    });
    const { amount, windowStart, windowEnd } = await computeAutoCommissionIncome(tx, userId, now);
    const qualified = amount.gte(AUTO_COMMISSION_THRESHOLD);
    const previousBucket = getThresholdBucket(toDecimal(existing?.currentAmount ?? 0));
    const currentBucket = getThresholdBucket(amount);
    const tierExpiries = parseTierExpiries(existing?.tierExpiries);

    if (
      currentBucket >= 1 &&
      !tierExpiries.has(currentBucket) &&
      existing?.activeUntil &&
      existing.activeUntil > now
    ) {
      // 兼容旧数据：上线前只有一个 activeUntil，没有分档位到期时间
      tierExpiries.set(currentBucket, existing.activeUntil);
    }

    let activeUntil: Date | null = null;
    let lastQualifiedAt: Date | null = existing?.lastQualifiedAt ?? null;

    if (currentBucket > previousBucket && currentBucket >= 1) {
      const refreshedUntil = new Date(now.getTime() + AUTO_COMMISSION_ACTIVE_DAYS * DAY_MS);
      for (let tier = previousBucket + 1; tier <= currentBucket; tier += 1) {
        tierExpiries.set(tier, refreshedUntil);
      }
      activeUntil = refreshedUntil;
      lastQualifiedAt = now;
    } else if (currentBucket >= 1) {
      // 回退档位时，恢复到对应档位原本的到期时间（不继承更高档位）
      activeUntil = resolveTierActiveUntil(tierExpiries, currentBucket, now);
    } else if (reason === 'revert') {
      // 撤销导致跌破 1 档，立即失效
      activeUntil = null;
    } else {
      // 非撤销场景下，保留当前有效期直到自然到期
      activeUntil =
        existing?.activeUntil && existing.activeUntil > now ? existing.activeUntil : null;
    }

    await tx.autoCommissionBuff.upsert({
      where: { userId },
      create: {
        userId,
        targetShare: AUTO_COMMISSION_TARGET_SHARE,
        thresholdAmount: AUTO_COMMISSION_THRESHOLD,
        windowDays: AUTO_COMMISSION_WINDOW_DAYS,
        windowStart,
        windowEnd,
        currentAmount: amount,
        tierExpiries: serializeTierExpiries(tierExpiries),
        activeUntil: activeUntil ?? undefined,
        lastQualifiedAt: lastQualifiedAt ?? undefined,
      },
      update: {
        targetShare: AUTO_COMMISSION_TARGET_SHARE,
        thresholdAmount: AUTO_COMMISSION_THRESHOLD,
        windowDays: AUTO_COMMISSION_WINDOW_DAYS,
        windowStart,
        windowEnd,
        currentAmount: amount,
        tierExpiries: serializeTierExpiries(tierExpiries),
        activeUntil,
        lastQualifiedAt,
      },
    });

    return {
      userId,
      amount,
      threshold: AUTO_COMMISSION_THRESHOLD,
      windowStart,
      windowEnd,
      activeUntil,
      qualified,
    };
  });
}

export async function refreshAllAutoCommissionBuffs(now = new Date()) {
  const peiwanRows = await prisma.pEIWAN.findMany({
    select: { discordUserId: true },
  });
  for (const row of peiwanRows) {
    try {
      await evaluateAutoCommissionBuffWithReason(row.discordUserId, 'manual', now);
    } catch (err) {
      console.error('[auto-commission] refresh one user failed', { userId: row.discordUserId, err });
    }
  }
}

export async function getAutoCommissionBoost(
  tx: TxLike,
  userId: string,
  baseShare: Prisma.Decimal,
): Promise<Prisma.Decimal> {
  const row = await tx.autoCommissionBuff.findUnique({
    where: { userId },
    select: {
      targetShare: true,
      activeUntil: true,
    },
  });
  if (!row?.activeUntil || row.activeUntil <= new Date()) return new Prisma.Decimal(0);

  const targetShare = toDecimal(row.targetShare ?? AUTO_COMMISSION_TARGET_SHARE);
  const boost = targetShare.sub(baseShare);
  return boost.gt(0) ? boost : new Prisma.Decimal(0);
}
