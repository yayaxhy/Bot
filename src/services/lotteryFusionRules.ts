import { LotteryPool } from '@prisma/client';

export const LOTTERY_FUSION_DRAW_NONCE_PREFIX = 'fusion:';
const LOTTERY_FUSION_SOURCE_KINDS = ['lottery', 'coupon', 'pointshop'] as const;
export type LotteryFusionSourceKind = (typeof LOTTERY_FUSION_SOURCE_KINDS)[number];

export const LOTTERY_FUSION_MAX_POOL_BY_COUNT: Record<number, LotteryPool> = {
  3: LotteryPool.MEDIUM,
  4: LotteryPool.ADVANCED,
  6: LotteryPool.SPECIAL,
};

const LOTTERY_POOL_ORDER = [
  LotteryPool.NORMAL,
  LotteryPool.MEDIUM,
  LotteryPool.ADVANCED,
  LotteryPool.SPECIAL,
] as const;

const getPoolsUpTo = (maxPool: LotteryPool): LotteryPool[] => {
  const maxPoolIndex = LOTTERY_POOL_ORDER.indexOf(maxPool);
  if (maxPoolIndex < 0) return [LotteryPool.NORMAL];
  return [...LOTTERY_POOL_ORDER.slice(0, maxPoolIndex + 1)];
};

export const getFusionEligiblePools = (count: number): LotteryPool[] | null => {
  if (count === 6) {
    return [LotteryPool.MEDIUM, LotteryPool.ADVANCED, LotteryPool.SPECIAL];
  }

  const maxPool = LOTTERY_FUSION_MAX_POOL_BY_COUNT[count];
  if (!maxPool) return null;
  return getPoolsUpTo(maxPool);
};

export const isLotteryFusionNonce = (nonce?: string | null) =>
  typeof nonce === 'string' && nonce.startsWith(LOTTERY_FUSION_DRAW_NONCE_PREFIX);

export const parseLotteryFusionSourceRef = (
  value?: string | null,
): { kind: LotteryFusionSourceKind; id: string } | null => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex < 0) {
    return { kind: 'lottery', id: normalized };
  }
  const kind = normalized.slice(0, separatorIndex) as LotteryFusionSourceKind;
  const id = normalized.slice(separatorIndex + 1).trim();
  if (!LOTTERY_FUSION_SOURCE_KINDS.includes(kind) || !id) return null;
  return { kind, id };
};
