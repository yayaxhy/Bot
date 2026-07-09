import {
  CouponStatus,
  LotteryPool,
  LotteryStatus,
  PointShopDeliveryStatus,
  PointShopDeliveryType,
} from '@prisma/client';
import { PRIZE_BY_VOUCHER_COUPON_TYPE } from '../config/voucherCatalog.js';
import prisma from '../db/prisma.js';
import {
  ensureJinleeIdentityForDiscordTx,
  type JinleeIdentity,
} from './jinleeAccountService.js';
import type { LotteryFusionSourceKind } from './lotteryFusionRules.js';

export type LotteryFusionSelectableItem = {
  sourceId: string;
  sourceKind: LotteryFusionSourceKind;
  prizeName: string;
  pool: LotteryPool;
  createdAt: Date;
  expiresAt: Date | null;
};

export type LotteryFusionSelectableGroup = {
  key: string;
  prizeName: string;
  pool: LotteryPool;
  count: number;
  earliestExpiresAt: Date | null;
  latestCreatedAt: Date;
  sourceIds: string[];
};

const WEB_FUSION_REQUEST_ID_PREFIX = 'WEB_FUSION:';
const BOT_FUSION_REQUEST_ID_PREFIX = 'BOT_FUSION:';
const LOTTERY_FUSION_FALLBACK_POOL_BY_PRIZE_NAME: Partial<Record<string, LotteryPool>> = {
  '9折券': LotteryPool.NORMAL,
  一日冠75折券: LotteryPool.ADVANCED,
  月冠名92折券: LotteryPool.SPECIAL,
  月冠名9折券: LotteryPool.SPECIAL,
  刮刮乐代金券: LotteryPool.NORMAL,
  陪玩评语券: LotteryPool.NORMAL,
  '5位数靓号卡': LotteryPool.ADVANCED,
  '抽成降1%券': LotteryPool.SPECIAL,
};

const POOL_SORT_WEIGHT: Record<LotteryPool, number> = {
  NORMAL: 0,
  MEDIUM: 1,
  ADVANCED: 2,
  SPECIAL: 3,
};

const sourceRef = (kind: LotteryFusionSourceKind, id: string) => `${kind}:${id}`;

const dateMillis = (value?: Date | null) => value?.getTime() ?? Number.POSITIVE_INFINITY;

const compareNullableDateAsc = (left?: Date | null, right?: Date | null) => {
  const leftMillis = dateMillis(left);
  const rightMillis = dateMillis(right);
  return leftMillis - rightMillis;
};

const compareSelectableItemOrder = (
  left: Pick<LotteryFusionSelectableItem, 'expiresAt' | 'createdAt' | 'sourceId'>,
  right: Pick<LotteryFusionSelectableItem, 'expiresAt' | 'createdAt' | 'sourceId'>,
) => {
  const expiryDiff = compareNullableDateAsc(left.expiresAt, right.expiresAt);
  if (expiryDiff !== 0) return expiryDiff;

  const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;

  return left.sourceId.localeCompare(right.sourceId, 'zh-CN');
};

export const resolveLotteryFusionPoolFallback = (prizeName?: string | null): LotteryPool => {
  const normalized = prizeName?.trim() ?? '';
  if (normalized && LOTTERY_FUSION_FALLBACK_POOL_BY_PRIZE_NAME[normalized]) {
    return LOTTERY_FUSION_FALLBACK_POOL_BY_PRIZE_NAME[normalized] as LotteryPool;
  }
  return LotteryPool.NORMAL;
};

export const buildLotteryFusionGroupKey = (item: Pick<LotteryFusionSelectableItem, 'prizeName' | 'pool'>) =>
  `${item.pool}:${item.prizeName.trim()}`;

export const buildBotLotteryFusionRequestId = (sessionId: string) =>
  `${BOT_FUSION_REQUEST_ID_PREFIX}${sessionId}`;

export const isWebLotteryFusionRequestId = (requestId?: string | null) =>
  typeof requestId === 'string' && requestId.startsWith(WEB_FUSION_REQUEST_ID_PREFIX);

export const getDefaultLotteryFusionTargetCount = (availableCount: number): 3 | 4 | 6 => {
  if (availableCount >= 4) return 4;
  return 3;
};

export const clampLotteryFusionTargetCount = (
  desiredCount: number,
  availableCount: number,
): 3 | 4 | 6 => {
  if (availableCount >= 6 && desiredCount >= 6) return 6;
  if (availableCount >= 4 && desiredCount >= 4) return 4;
  return 3;
};

export const syncLotteryFusionSelection = (
  selectedSourceIds: string[],
  availableItems: Array<Pick<LotteryFusionSelectableItem, 'sourceId'>>,
) => {
  const availableIds = new Set(availableItems.map((item) => item.sourceId));
  return selectedSourceIds.filter((sourceId) => availableIds.has(sourceId));
};

export const buildLotteryFusionSelectableGroups = (
  items: LotteryFusionSelectableItem[],
): LotteryFusionSelectableGroup[] => {
  const groupMap = new Map<
    string,
    {
      key: string;
      prizeName: string;
      pool: LotteryPool;
      earliestExpiresAt: Date | null;
      latestCreatedAt: Date;
      items: LotteryFusionSelectableItem[];
    }
  >();

  for (const item of items) {
    const key = buildLotteryFusionGroupKey(item);
    const current = groupMap.get(key);
    if (!current) {
      groupMap.set(key, {
        key,
        prizeName: item.prizeName,
        pool: item.pool,
        earliestExpiresAt: item.expiresAt,
        latestCreatedAt: item.createdAt,
        items: [item],
      });
      continue;
    }

    current.items.push(item);
    if (compareNullableDateAsc(item.expiresAt, current.earliestExpiresAt) < 0) {
      current.earliestExpiresAt = item.expiresAt;
    }
    if (item.createdAt.getTime() > current.latestCreatedAt.getTime()) {
      current.latestCreatedAt = item.createdAt;
    }
  }

  return [...groupMap.values()]
    .map((group) => {
      const orderedItems = [...group.items].sort(compareSelectableItemOrder);
      return {
        key: group.key,
        prizeName: group.prizeName,
        pool: group.pool,
        count: orderedItems.length,
        earliestExpiresAt: orderedItems[0]?.expiresAt ?? null,
        latestCreatedAt: group.latestCreatedAt,
        sourceIds: orderedItems.map((item) => item.sourceId),
      };
    })
    .sort((left, right) => {
      const expiryDiff = compareNullableDateAsc(left.earliestExpiresAt, right.earliestExpiresAt);
      if (expiryDiff !== 0) return expiryDiff;

      const poolDiff = (POOL_SORT_WEIGHT[left.pool] ?? 99) - (POOL_SORT_WEIGHT[right.pool] ?? 99);
      if (poolDiff !== 0) return poolDiff;

      const createdDiff = left.latestCreatedAt.getTime() - right.latestCreatedAt.getTime();
      if (createdDiff !== 0) return createdDiff;

      return left.prizeName.localeCompare(right.prizeName, 'zh-CN');
    });
};

export const takeNextSourceIdFromFusionGroup = (
  group: Pick<LotteryFusionSelectableGroup, 'sourceIds'>,
  selectedSourceIds: string[],
) => {
  const selectedSet = new Set(selectedSourceIds);
  return group.sourceIds.find((sourceId) => !selectedSet.has(sourceId)) ?? null;
};

export const takeLastSelectedSourceIdFromFusionGroup = (
  group: Pick<LotteryFusionSelectableGroup, 'sourceIds'>,
  selectedSourceIds: string[],
) => {
  for (let index = group.sourceIds.length - 1; index >= 0; index -= 1) {
    const sourceId = group.sourceIds[index];
    if (selectedSourceIds.includes(sourceId)) {
      return sourceId;
    }
  }
  return null;
};

const buildPrizePoolByName = async (prizeNames: string[]) => {
  if (!prizeNames.length) return new Map<string, LotteryPool>();

  const prizes = await prisma.lotteryPrize.findMany({
    where: { name: { in: prizeNames } },
    select: { name: true, pool: true },
  });

  return prizes.reduce((map, prize) => {
    map.set(prize.name, prize.pool);
    return map;
  }, new Map<string, LotteryPool>());
};

export const getLotteryFusionSelectableInventoryForDiscordUser = async (
  discordUserId: string,
): Promise<{ identity: JinleeIdentity; items: LotteryFusionSelectableItem[] }> => {
  const identity = await ensureJinleeIdentityForDiscordTx(prisma, discordUserId);
  const now = new Date();

  const [draws, coupons, pointShopGrants] = await Promise.all([
    prisma.lotteryDraw.findMany({
      where: {
        jinleeId: identity.jinleeId,
        status: LotteryStatus.UNUSED,
        consumeAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: {
        prize: {
          select: {
            name: true,
            pool: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 300,
    }),
    prisma.coupon.findMany({
      where: {
        jinleeId: identity.jinleeId,
        status: CouponStatus.ACTIVE,
        expiresAt: { gt: now },
        consumedAt: null,
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: 300,
    }),
    prisma.pointShopGrant.findMany({
      where: {
        jinleeId: identity.jinleeId,
        deliveryType: PointShopDeliveryType.COUPON,
        deliveryStatus: PointShopDeliveryStatus.DELIVERED,
        couponStatus: CouponStatus.ACTIVE,
        consumedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: 300,
    }),
  ]);

  const couponPrizeNames = coupons
    .map((coupon) => PRIZE_BY_VOUCHER_COUPON_TYPE[coupon.type] ?? String(coupon.type))
    .filter(Boolean);
  const pointShopPrizeNames = pointShopGrants
    .map((grant) =>
      grant.couponType
        ? (PRIZE_BY_VOUCHER_COUPON_TYPE[grant.couponType] ?? grant.itemName.trim())
        : grant.itemName.trim(),
    )
    .filter(Boolean);

  const prizePoolByName = await buildPrizePoolByName([
    ...new Set([...couponPrizeNames, ...pointShopPrizeNames]),
  ]);

  const drawItems: LotteryFusionSelectableItem[] = draws
    .filter((draw) => draw.prize?.name)
    .map((draw) => ({
      sourceId: sourceRef('lottery', draw.id),
      sourceKind: 'lottery',
      prizeName: draw.prize?.name ?? '未命名奖品',
      pool: draw.prize?.pool ?? draw.pool,
      createdAt: draw.createdAt,
      expiresAt: draw.expiresAt ?? null,
    }));

  const couponItems: LotteryFusionSelectableItem[] = coupons.map((coupon) => {
    const prizeName = PRIZE_BY_VOUCHER_COUPON_TYPE[coupon.type] ?? String(coupon.type);
    return {
      sourceId: sourceRef('coupon', coupon.id),
      sourceKind: 'coupon',
      prizeName,
      pool: prizePoolByName.get(prizeName) ?? resolveLotteryFusionPoolFallback(prizeName),
      createdAt: coupon.issuedAt,
      expiresAt: coupon.expiresAt ?? null,
    };
  });

  const pointShopItems: LotteryFusionSelectableItem[] = pointShopGrants.map((grant) => {
    const prizeName = grant.couponType
      ? (PRIZE_BY_VOUCHER_COUPON_TYPE[grant.couponType] ?? grant.itemName.trim())
      : grant.itemName.trim();
    return {
      sourceId: sourceRef('pointshop', grant.id),
      sourceKind: 'pointshop',
      prizeName,
      pool: prizePoolByName.get(prizeName) ?? resolveLotteryFusionPoolFallback(prizeName),
      createdAt: grant.issuedAt,
      expiresAt: grant.expiresAt ?? null,
    };
  });

  const items = [...drawItems, ...couponItems, ...pointShopItems].sort(compareSelectableItemOrder);
  return { identity, items };
};
