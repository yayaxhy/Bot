import { LotteryPool, LotteryStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import crypto from 'crypto';

type TxClient = Prisma.TransactionClient;

export const DRAW_COST = new Prisma.Decimal(29);
const VOUCHER_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SHORT_ID_BYTES = 4;
const ALERT_CHANNEL_ID = '1446819752692416542';
const PITY_THRESHOLD = 99; // 100 抽保底（missCount >= 99 时强制特级）

export const PRIZE_NAMES = {
  CAKE_VOUCHER: '小蛋糕礼物的代金券',
  LOTTERY_VOUCHER: '抽奖代金券',
  DISCOUNT_80: '8折券',
  RENAME_CARD: '改名卡',
} as const;

const PRIZE_NAME_BY_KIND: Record<PrizeKind, string | null> = {
  CAKE_VOUCHER: PRIZE_NAMES.CAKE_VOUCHER,
  LOTTERY_VOUCHER: PRIZE_NAMES.LOTTERY_VOUCHER,
  DISCOUNT_80: PRIZE_NAMES.DISCOUNT_80,
  RENAME_CARD: PRIZE_NAMES.RENAME_CARD,
  OTHER: null,
};

export type PrizeKind =
  | 'CAKE_VOUCHER'
  | 'LOTTERY_VOUCHER'
  | 'DISCOUNT_80'
  | 'RENAME_CARD'
  | 'OTHER';

export const POOL_LABEL: Record<LotteryPool, string> = {
  NORMAL: '银色',
  MEDIUM: '金色',
  ADVANCED: '高级',
  SPECIAL: '特级',
};

export class LotteryError extends Error {
  code:
    | 'INSUFFICIENT_BALANCE'
    | 'NO_PRIZE_AVAILABLE'
    | 'NO_FALLBACK_PRIZE'
    | 'MISSING_PRIZE';
  constructor(code: LotteryError['code'], message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

type PrizeLike = {
  id: string;
  name: string;
  pool: LotteryPool;
  weight: number;
  unlimited: boolean;
  stock: number | null;
  imageUrl: string | null;
};

const normalizeName = (name?: string | null) => (name ?? '').trim();

export function classifyPrize(prizeName?: string | null): PrizeKind {
  const normalized = normalizeName(prizeName);
  switch (normalized) {
    case PRIZE_NAMES.CAKE_VOUCHER:
      return 'CAKE_VOUCHER';
    case PRIZE_NAMES.LOTTERY_VOUCHER:
      return 'LOTTERY_VOUCHER';
    case PRIZE_NAMES.DISCOUNT_80:
      return 'DISCOUNT_80';
    case PRIZE_NAMES.RENAME_CARD:
      return 'RENAME_CARD';
    default:
      return 'OTHER';
  }
}

const generateCode = (kind: PrizeKind): string => {
  const prefixMap: Record<PrizeKind, string> = {
    CAKE_VOUCHER: 'CAKE',
    LOTTERY_VOUCHER: 'DRAW',
    DISCOUNT_80: 'D80',
    RENAME_CARD: 'RENAME',
    OTHER: 'PRIZE',
  };
  const short = crypto.randomBytes(SHORT_ID_BYTES).toString('hex');
  return `${prefixMap[kind]}-${short}`;
};

const voucherExpiresAt = (kind: PrizeKind, now: Date) =>
  kind === 'OTHER' ? null : new Date(now.getTime() + VOUCHER_EXPIRES_MS);

const sendLotteryAlert = async (text: string) => {
  try {
    const client = (globalThis as any).__CLIENT__;
    if (!client || !ALERT_CHANNEL_ID) return;
    const channel = await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel.send({ content: text });
    }
  } catch (err) {
    console.error('[lottery][alert] send failed:', err);
  }
};

const adjustWeight = (p: PrizeLike) => {
  if (p.unlimited) return Math.max(0, p.weight);
  const stockFactor = Math.max(0, p.stock ?? 0);
  return Math.max(0, p.weight * stockFactor);
};

const pickByWeight = (items: PrizeLike[]): PrizeLike | null => {
  const weights = items.map((p) => adjustWeight(p));
  const total = weights.reduce((acc, w) => acc + w, 0);
  if (total <= 0) return null;
  const r = Math.random() * total;
  let acc = 0;
  for (let idx = 0; idx < items.length; idx++) {
    acc += weights[idx];
    if (r <= acc) return items[idx];
  }
  return items[items.length - 1] ?? null;
};

async function loadCandidates(
  tx: TxClient,
  pool?: LotteryPool
): Promise<PrizeLike[]> {
  return tx.lotteryPrize.findMany({
    where: {
      active: true,
      ...(pool ? { pool } : {}),
      OR: [{ unlimited: true }, { stock: { gt: 0 } }],
    },
  });
}

async function pickPrize(
  tx: TxClient,
  pool?: LotteryPool
): Promise<PrizeLike> {
  const candidates = await loadCandidates(tx, pool);
  if (candidates.length === 0) {
    throw new LotteryError(pool ? 'NO_FALLBACK_PRIZE' : 'NO_PRIZE_AVAILABLE');
  }
  const picked = pickByWeight(candidates);
  if (!picked) {
    throw new LotteryError(pool ? 'NO_FALLBACK_PRIZE' : 'NO_PRIZE_AVAILABLE');
  }
  return picked;
}

async function consumeStock(
  tx: TxClient,
  prize: PrizeLike
): Promise<boolean> {
  if (prize.unlimited) return true;
  const res = await tx.lotteryPrize.updateMany({
    where: { id: prize.id, stock: { gt: 0 } },
    data: { stock: { decrement: 1 } },
  });
  return res.count > 0;
}

export type LotteryResult = {
  drawId: string;
  prize: PrizeLike;
  pool: LotteryPool;
  random: number;
  cost: Prisma.Decimal;
};

export async function performLotteryDraw(params: {
  userId: string;
  nonce: string;
  requestId?: string;
  pool?: LotteryPool;
}): Promise<LotteryResult> {
  const { userId, nonce, requestId, pool } = params;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.lotteryDraw.findUnique({
      where: { nonce },
      include: { prize: true },
    });
    if (existing) {
      if (!existing.prize) throw new LotteryError('MISSING_PRIZE');
      return {
        drawId: existing.id,
        prize: existing.prize as PrizeLike,
        pool: existing.pool,
        random: existing.random ?? Math.random(),
        cost: new Prisma.Decimal(existing.cost ?? 0),
      };
    }

    // 先过期掉过期券
    await tx.lotteryDraw.updateMany({
      where: { userId, status: LotteryStatus.UNUSED, expiresAt: { lte: now } },
      data: { status: LotteryStatus.EXPIRED },
    });

    // 抽奖代金券：按最早优先，如果存在则免扣款
    const freeVoucher = await tx.lotteryDraw.findFirst({
      where: {
        userId,
        status: LotteryStatus.UNUSED,
        expiresAt: { gt: now },
        prize: { name: PRIZE_NAMES.LOTTERY_VOUCHER },
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    });

    const useFreeVoucher = !!freeVoucher;

    if (useFreeVoucher) {
      await tx.lotteryDraw.update({
        where: { id: freeVoucher!.id },
        data: { status: LotteryStatus.USED, consumeAt: now },
      });
    }

    await tx.member.upsert({
      where: { discordUserId: userId },
      update: {},
      create: { discordUserId: userId },
    });

    if (!useFreeVoucher) {
      const debit = await tx.member.updateMany({
        where: { discordUserId: userId, totalBalance: { gte: DRAW_COST } },
        data: {
          totalBalance: { decrement: DRAW_COST },
          totalSpent: { increment: DRAW_COST },
        },
      });
      if (debit.count === 0) {
        throw new LotteryError('INSUFFICIENT_BALANCE');
      }
    }

    // 读取/初始化保底计数
    const pity = await tx.lotteryPity.upsert({
      where: { userId },
      update: {},
      create: { userId, missCount: 0 },
    });
    const shouldForceSpecial = pity.missCount >= PITY_THRESHOLD;

    let picked: PrizeLike | null = null;
    let forcedSpecial = false;
    let forcedButNoSpecial = false;

    if (shouldForceSpecial) {
      forcedSpecial = true;
      try {
        picked = await pickPrize(tx, LotteryPool.SPECIAL);
      } catch (err) {
        forcedButNoSpecial = true;
        await sendLotteryAlert(`[lottery][pity] 用户 ${userId} 触发保底，但特级奖池无可用库存，回落到其他奖池`);
      }
    }

    if (!picked) {
      picked = await pickPrize(tx, pool);
    }

    if (!picked.unlimited) {
      if (picked.pool === LotteryPool.SPECIAL && (picked.stock ?? 0) === 1) {
        await sendLotteryAlert(`[lottery][stock] 特级奖品「${picked.name}」仅剩 1 个库存`);
      }
      const ok = await consumeStock(tx, picked);
      if (!ok) {
        await sendLotteryAlert(`[lottery][stock_empty] 奖品「${picked.name}」库存不足，回落到金色池`);
        picked = await pickPrize(tx, LotteryPool.MEDIUM);
        // medium 也可能有限，再次尝试扣减；失败则抛错
        if (!picked.unlimited) {
          const fallbackOk = await consumeStock(tx, picked);
          if (!fallbackOk) throw new LotteryError('NO_FALLBACK_PRIZE');
        }
      }
    }

    const randomVal = Math.random();
    const kind = classifyPrize(picked.name);
    const expiresAt = voucherExpiresAt(kind, now);
    const code = generateCode(kind);
    const cost = useFreeVoucher ? new Prisma.Decimal(0) : DRAW_COST;

    const draw = await tx.lotteryDraw.create({
      data: {
        nonce,
        requestId,
        userId,
        pool: picked.pool,
        prizeId: picked.id,
        cost,
        random: randomVal,
        expiresAt: expiresAt ?? undefined,
        code,
      },
      include: { prize: true },
    });

    if (!draw.prize) throw new LotteryError('MISSING_PRIZE');

    // 更新保底计数：特级命中清零；非特级 +1；保底但无特级库存时不变
    let nextMiss = pity.missCount;
    if (draw.prize.pool === LotteryPool.SPECIAL) {
      nextMiss = 0;
    } else if (!forcedButNoSpecial) {
      nextMiss = pity.missCount + 1;
    }
    await tx.lotteryPity.update({
      where: { userId },
      data: { missCount: nextMiss },
    });

    return {
      drawId: draw.id,
      prize: draw.prize as PrizeLike,
      pool: draw.pool,
      random: draw.random ?? randomVal,
      cost: draw.cost,
    };
  });
}

export async function consumeVouchers(
  tx: TxClient,
  userId: string,
  kind: PrizeKind,
  count: number,
  now: Date
): Promise<{ usedIds: string[] }> {
  const prizeName = PRIZE_NAME_BY_KIND[kind];
  if (!prizeName) return { usedIds: [] };
  if (count <= 0) return { usedIds: [] };
  await tx.lotteryDraw.updateMany({
    where: { userId, status: LotteryStatus.UNUSED, expiresAt: { lte: now } },
    data: { status: LotteryStatus.EXPIRED },
  });
  const rows = await tx.lotteryDraw.findMany({
    where: {
      userId,
      status: LotteryStatus.UNUSED,
      expiresAt: { gt: now },
      prize: { name: prizeName },
    },
    select: { id: true },
    orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    take: count,
  });
  if (rows.length === 0) return { usedIds: [] };
  const ids = rows.map((r) => r.id);
  await tx.lotteryDraw.updateMany({
    where: { id: { in: ids } },
    data: { status: LotteryStatus.USED, consumeAt: now },
  });
  return { usedIds: ids };
}
