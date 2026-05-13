import { CouponStatus, CouponType, LotteryPool, LotteryPrizeType, LotteryStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import crypto from 'crypto';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { consumeSpendBuff } from './buffService.js';
import { awardVipAdjustedLoyaltyPointsTx } from './loyaltyPointService.js';
import {
  applyJinleeWalletDeltaTx,
  ensureJinleeIdentityForDiscordTx,
  getJinleeWalletSnapshotTx,
  lockJinleeUserForUpdateTx,
} from './jinleeAccountService.js';
import { scheduleSpentRoleSync } from './spentRoleService.js';

type TxClient = Prisma.TransactionClient;

export const DRAW_COST = new Prisma.Decimal(29);
export const TEN_DRAW_COST = new Prisma.Decimal(290);
const VOUCHER_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SHORT_ID_BYTES = 4;
const ALERT_CHANNEL_ID = '1446819752692416542';

export const PRIZE_NAMES = {
  CAKE_VOUCHER: '小蛋糕代金券',
  LOTTERY_VOUCHER: '抽奖代金券',
  BLOCK_STACK_VOUCHER: '积木游戏代金券',
  PEIWAN_REVIEW_VOUCHER: '陪玩评语券',
  DISCOUNT_80: '8折券',
  RENAME_CARD_3: '3位数靓号卡',
  RENAME_CARD: '4位数靓号卡',
  RENAME_CARD_5: '5位数靓号卡',
  LOLLIPOP_VOUCHER: '棒棒糖代金券',
  PERFUME_VOUCHER: '香水代金券',
  CAROUSEL_VOUCHER: '旋转木马代金券',
  PUMPKIN_CAR_VOUCHER: '南瓜车代金券',
  PHONOGRAPH_VOUCHER: '留声机代金券',
  CROWN_75_VOUCHER: '一日冠75折券',
  CROWN_DAY_90_VOUCHER: '一日冠9折券',
  CROWN_3DAY_90_VOUCHER: '三日冠9折券',
  CROWN_WEEK_90_VOUCHER: '一周冠9折券',
  CROWN_DAY_92_VOUCHER: '一日冠92折券',
  CROWN_3DAY_92_VOUCHER: '三日冠92折券',
  CROWN_WEEK_92_VOUCHER: '一周冠92折券',
  CROWN_MONTH_90_VOUCHER: '月冠名9折券',
  CUSTOM_GIFT_VOUCHER: '自定义礼物券',
  CUSTOM_TAG_VOUCHER: '自定义tag券',
  COMMISSION_MINUS1_VOUCHER: '抽成降1%券',
  DOUBLE_FLOW_5000_VOUCHER: '双倍流水5000券',
  DOUBLE_SPEND_5000_VOUCHER: '双倍消费5000券',
  CHAMPAGNE_VOUCHER: '香槟代金券',
  BUTTERFLY_VOUCHER: '蝴蝶代金券',
  PIANO_VOUCHER: '钢琴代金券',
  AIRPLANE_VOUCHER: '飞机代金券',
  DEEP_SEA_CHEST_VOUCHER: '深海宝箱代金券',
  DISCOUNT_70: '7折券',
  DISCOUNT_90_LOTTERY: '特殊9折券',
  RABBIT_BABY: '兔兔宝宝',
  FOX_BABY: '狐狸宝宝',
  PIGGY_BABY: '猪猪宝宝',
  CHICK_BABY: '小鸡宝宝',
} as const;

export const TEN_DRAW_GUARANTEE_PRIZE_NAMES = [
  PRIZE_NAMES.CHAMPAGNE_VOUCHER,
  PRIZE_NAMES.BUTTERFLY_VOUCHER,
  PRIZE_NAMES.PIANO_VOUCHER,
  PRIZE_NAMES.AIRPLANE_VOUCHER,
  PRIZE_NAMES.DEEP_SEA_CHEST_VOUCHER,
] as const;
const TEN_DRAW_FIXED_PRIZE_NAME = PRIZE_NAMES.BUTTERFLY_VOUCHER;

const TEN_DRAW_ROTATION_RECIPES: ReadonlyArray<{
  normal: number;
  butterfly: number;
  random: number;
}> = [
  { normal: 4, butterfly: 1, random: 5 },
  { normal: 4, butterfly: 1, random: 5 },
  { normal: 4, butterfly: 1, random: 5 },
  { normal: 3, butterfly: 1, random: 6 },
  { normal: 3, butterfly: 1, random: 6 },
];
const TEN_DRAW_COUNTER_ROW_ID = 1;

export const RENAME_CARD_NAMES: string[] = [
  PRIZE_NAMES.RENAME_CARD_3,
  PRIZE_NAMES.RENAME_CARD,
  PRIZE_NAMES.RENAME_CARD_5,
];

const PRIZE_NAME_BY_KIND: Record<PrizeKind, string | null> = {
  CAKE_VOUCHER: PRIZE_NAMES.CAKE_VOUCHER,
  LOTTERY_VOUCHER: PRIZE_NAMES.LOTTERY_VOUCHER,
  BLOCK_STACK_VOUCHER: PRIZE_NAMES.BLOCK_STACK_VOUCHER,
  DISCOUNT_80: PRIZE_NAMES.DISCOUNT_80,
  RENAME_CARD_3: PRIZE_NAMES.RENAME_CARD_3,
  RENAME_CARD: PRIZE_NAMES.RENAME_CARD,
  RENAME_CARD_5: PRIZE_NAMES.RENAME_CARD_5,
  LOLLIPOP_VOUCHER: PRIZE_NAMES.LOLLIPOP_VOUCHER,
  PERFUME_VOUCHER: PRIZE_NAMES.PERFUME_VOUCHER,
  CAROUSEL_VOUCHER: PRIZE_NAMES.CAROUSEL_VOUCHER,
  PUMPKIN_CAR_VOUCHER: PRIZE_NAMES.PUMPKIN_CAR_VOUCHER,
  PHONOGRAPH_VOUCHER: PRIZE_NAMES.PHONOGRAPH_VOUCHER,
  CROWN_75_VOUCHER: PRIZE_NAMES.CROWN_75_VOUCHER,
  CROWN_DAY_90_VOUCHER: PRIZE_NAMES.CROWN_DAY_90_VOUCHER,
  CROWN_3DAY_90_VOUCHER: PRIZE_NAMES.CROWN_3DAY_90_VOUCHER,
  CROWN_WEEK_90_VOUCHER: PRIZE_NAMES.CROWN_WEEK_90_VOUCHER,
  CROWN_MONTH_90_VOUCHER: PRIZE_NAMES.CROWN_MONTH_90_VOUCHER,
  CUSTOM_GIFT_VOUCHER: PRIZE_NAMES.CUSTOM_GIFT_VOUCHER,
  CUSTOM_TAG_VOUCHER: PRIZE_NAMES.CUSTOM_TAG_VOUCHER,
  COMMISSION_MINUS1_VOUCHER: PRIZE_NAMES.COMMISSION_MINUS1_VOUCHER,
  DOUBLE_FLOW_5000_VOUCHER: PRIZE_NAMES.DOUBLE_FLOW_5000_VOUCHER,
  DOUBLE_SPEND_5000_VOUCHER: PRIZE_NAMES.DOUBLE_SPEND_5000_VOUCHER,
  DISCOUNT_70: PRIZE_NAMES.DISCOUNT_70,
  DISCOUNT_90_LOTTERY: PRIZE_NAMES.DISCOUNT_90_LOTTERY,
  RABBIT_BABY: PRIZE_NAMES.RABBIT_BABY,
  FOX_BABY: PRIZE_NAMES.FOX_BABY,
  PIGGY_BABY: PRIZE_NAMES.PIGGY_BABY,
  CHICK_BABY: PRIZE_NAMES.CHICK_BABY,
  GIFT: null,
  OTHER: null,
};

export type PrizeKind =
  | 'CAKE_VOUCHER'
  | 'LOTTERY_VOUCHER'
  | 'BLOCK_STACK_VOUCHER'
  | 'DISCOUNT_80'
  | 'RENAME_CARD_3'
  | 'RENAME_CARD'
  | 'RENAME_CARD_5'
  | 'LOLLIPOP_VOUCHER'
  | 'PERFUME_VOUCHER'
  | 'CAROUSEL_VOUCHER'
  | 'PUMPKIN_CAR_VOUCHER'
  | 'PHONOGRAPH_VOUCHER'
  | 'CROWN_75_VOUCHER'
  | 'CROWN_DAY_90_VOUCHER'
  | 'CROWN_3DAY_90_VOUCHER'
  | 'CROWN_WEEK_90_VOUCHER'
  | 'CROWN_MONTH_90_VOUCHER'
  | 'CUSTOM_GIFT_VOUCHER'
  | 'CUSTOM_TAG_VOUCHER'
  | 'COMMISSION_MINUS1_VOUCHER'
  | 'DOUBLE_FLOW_5000_VOUCHER'
  | 'DOUBLE_SPEND_5000_VOUCHER'
  | 'DISCOUNT_70'
  | 'DISCOUNT_90_LOTTERY'
  | 'RABBIT_BABY'
  | 'FOX_BABY'
  | 'PIGGY_BABY'
  | 'CHICK_BABY'
  | 'GIFT'
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
  type: LotteryPrizeType;
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
    case PRIZE_NAMES.BLOCK_STACK_VOUCHER:
      return 'BLOCK_STACK_VOUCHER';
    case PRIZE_NAMES.DISCOUNT_80:
      return 'DISCOUNT_80';
    case PRIZE_NAMES.RENAME_CARD_3:
      return 'RENAME_CARD_3';
    case PRIZE_NAMES.RENAME_CARD:
      return 'RENAME_CARD';
    case PRIZE_NAMES.RENAME_CARD_5:
      return 'RENAME_CARD_5';
    case PRIZE_NAMES.LOLLIPOP_VOUCHER:
      return 'LOLLIPOP_VOUCHER';
    case PRIZE_NAMES.PERFUME_VOUCHER:
      return 'PERFUME_VOUCHER';
    case PRIZE_NAMES.CAROUSEL_VOUCHER:
      return 'CAROUSEL_VOUCHER';
    case PRIZE_NAMES.PUMPKIN_CAR_VOUCHER:
      return 'PUMPKIN_CAR_VOUCHER';
    case PRIZE_NAMES.PHONOGRAPH_VOUCHER:
      return 'PHONOGRAPH_VOUCHER';
    case PRIZE_NAMES.CROWN_75_VOUCHER:
      return 'CROWN_75_VOUCHER';
    case PRIZE_NAMES.CROWN_DAY_90_VOUCHER:
      return 'CROWN_DAY_90_VOUCHER';
    case PRIZE_NAMES.CROWN_3DAY_90_VOUCHER:
      return 'CROWN_3DAY_90_VOUCHER';
    case PRIZE_NAMES.CROWN_WEEK_90_VOUCHER:
      return 'CROWN_WEEK_90_VOUCHER';
    case PRIZE_NAMES.CROWN_MONTH_90_VOUCHER:
      return 'CROWN_MONTH_90_VOUCHER';
    case PRIZE_NAMES.CUSTOM_GIFT_VOUCHER:
      return 'CUSTOM_GIFT_VOUCHER';
    case PRIZE_NAMES.CUSTOM_TAG_VOUCHER:
      return 'CUSTOM_TAG_VOUCHER';
    case PRIZE_NAMES.COMMISSION_MINUS1_VOUCHER:
      return 'COMMISSION_MINUS1_VOUCHER';
    case PRIZE_NAMES.DOUBLE_FLOW_5000_VOUCHER:
      return 'DOUBLE_FLOW_5000_VOUCHER';
    case PRIZE_NAMES.DOUBLE_SPEND_5000_VOUCHER:
      return 'DOUBLE_SPEND_5000_VOUCHER';
    case PRIZE_NAMES.DISCOUNT_70:
      return 'DISCOUNT_70';
    case PRIZE_NAMES.DISCOUNT_90_LOTTERY:
      return 'DISCOUNT_90_LOTTERY';
    case PRIZE_NAMES.RABBIT_BABY:
      return 'RABBIT_BABY';
    case PRIZE_NAMES.FOX_BABY:
      return 'FOX_BABY';
    case PRIZE_NAMES.PIGGY_BABY:
      return 'PIGGY_BABY';
    case PRIZE_NAMES.CHICK_BABY:
      return 'CHICK_BABY';
    default:
      return 'OTHER';
  }
}

const generateCode = (kind: PrizeKind): string => {
  const prefixMap: Record<PrizeKind, string> = {
    CAKE_VOUCHER: 'CAKE',
    LOTTERY_VOUCHER: 'DRAW',
    BLOCK_STACK_VOUCHER: 'BSTACK',
    DISCOUNT_80: 'D80',
    RENAME_CARD_3: 'RENAME3',
    RENAME_CARD: 'RENAME',
    RENAME_CARD_5: 'RENAME5',
    LOLLIPOP_VOUCHER: 'LOLLI',
    PERFUME_VOUCHER: 'PERF',
    CAROUSEL_VOUCHER: 'CARO',
    PUMPKIN_CAR_VOUCHER: 'PUMP',
    PHONOGRAPH_VOUCHER: 'PHONO',
    CROWN_75_VOUCHER: 'CROWN',
    CROWN_DAY_90_VOUCHER: 'CR90D1',
    CROWN_3DAY_90_VOUCHER: 'CR90D3',
    CROWN_WEEK_90_VOUCHER: 'CR90W',
    CROWN_MONTH_90_VOUCHER: 'CR90M',
    CUSTOM_GIFT_VOUCHER: 'CGIFT',
    CUSTOM_TAG_VOUCHER: 'CTAG',
    COMMISSION_MINUS1_VOUCHER: 'FEE1',
    DOUBLE_FLOW_5000_VOUCHER: 'FLOW2',
    DOUBLE_SPEND_5000_VOUCHER: 'SPEND2',
    DISCOUNT_70: 'D70',
    DISCOUNT_90_LOTTERY: 'D90',
    RABBIT_BABY: 'RBABY',
    FOX_BABY: 'FBABY',
    PIGGY_BABY: 'PBABY',
    CHICK_BABY: 'CBABY',
    GIFT: 'GIFT',
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
  return Math.max(0, p.weight);
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
  options?: {
    pool?: LotteryPool;
    prizeNames?: string[];
  }
): Promise<PrizeLike[]> {
  return tx.lotteryPrize.findMany({
    where: {
      active: true,
      ...(options?.pool ? { pool: options.pool } : {}),
      ...(options?.prizeNames?.length ? { name: { in: options.prizeNames } } : {}),
      OR: [{ unlimited: true }, { stock: { gt: 0 } }],
    },
  });
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

async function maybeAlertSpecialLowStock(tx: TxClient, prize: PrizeLike) {
  if (prize.unlimited || prize.pool !== LotteryPool.SPECIAL) return;
  const latest = await tx.lotteryPrize.findUnique({
    where: { id: prize.id },
    select: { stock: true },
  });
  if ((latest?.stock ?? 0) === 1) {
    await sendLotteryAlert(`[lottery][stock] 特级奖品「${prize.name}」仅剩 1 个库存`);
  }
}

export type LotteryResult = {
  drawId: string;
  prize: PrizeLike;
  pool: LotteryPool;
  random: number;
  cost: Prisma.Decimal;
};

export type LotteryBatchResult = {
  draws: LotteryResult[];
  cost: Prisma.Decimal;
};

async function pickAndConsumePrize(
  tx: TxClient,
  options?: {
    pool?: LotteryPool;
    prizeNames?: string[];
  }
): Promise<PrizeLike> {
  const exhaustedIds = new Set<string>();

  while (true) {
    const candidates = (await loadCandidates(tx, options)).filter((candidate) => !exhaustedIds.has(candidate.id));
    if (candidates.length === 0) {
      throw new LotteryError(options?.pool || options?.prizeNames?.length ? 'NO_FALLBACK_PRIZE' : 'NO_PRIZE_AVAILABLE');
    }

    const picked = pickByWeight(candidates);
    if (!picked) {
      throw new LotteryError(options?.pool || options?.prizeNames?.length ? 'NO_FALLBACK_PRIZE' : 'NO_PRIZE_AVAILABLE');
    }
    if (picked.unlimited) return picked;

    const ok = await consumeStock(tx, picked);
    if (ok) return picked;
    exhaustedIds.add(picked.id);
    await sendLotteryAlert(`[lottery][stock_empty] 奖品「${picked.name}」库存不足，已在当前奖池重试`);
  }
}

async function chargeLotteryCostTx(
  tx: TxClient,
  params: {
    payerIdentity: Awaited<ReturnType<typeof ensureJinleeIdentityForDiscordTx>>;
    amount: Prisma.Decimal;
    now: Date;
  }
) {
  const { payerIdentity, amount, now } = params;
  const walletSnapshot = await getJinleeWalletSnapshotTx(tx, payerIdentity);
  const income = walletSnapshot.income;
  const recharge = walletSnapshot.recharge;
  const total = walletSnapshot.totalBalance;
  if (total.lt(amount)) {
    throw new LotteryError('INSUFFICIENT_BALANCE');
  }
  const split = splitIncomeRecharge(income, recharge, amount);
  const spendBonus =
    payerIdentity.discordUserId != null
      ? await consumeSpendBuff(tx, payerIdentity.discordUserId, amount)
      : { extra: new Prisma.Decimal(0), remaining: new Prisma.Decimal(0) };
  const totalSpentIncrement = amount.add(spendBonus.extra);
  await applyJinleeWalletDeltaTx(tx, {
    jinleeId: payerIdentity.jinleeId,
    discordUserId: payerIdentity.discordUserId,
    incomeDelta: split.fromIncome.neg(),
    rechargeDelta: split.fromRecharge.neg(),
    totalBalanceDelta: amount.neg(),
    totalSpentDelta: totalSpentIncrement,
  });
  await awardVipAdjustedLoyaltyPointsTx(tx, payerIdentity, amount);
  const balanceBefore = total;
  const balanceAfter = total.sub(amount);
  await recordIndividualTransaction(tx, {
    discordId: payerIdentity.discordUserId,
    jinleeId: payerIdentity.jinleeId,
    thirdPartydiscordId: 'SYSTEM',
    balanceBefore,
    amountChange: amount,
    balanceAfter,
    typeOfTransaction: '抽奖消费',
    timeCreatedAt: now,
  });
}

const resolvePrizeKind = (prize: PrizeLike): PrizeKind => {
  const classified = classifyPrize(prize.name);
  if (classified !== 'OTHER') return classified;
  if (prize.type === LotteryPrizeType.GIFT) return 'GIFT';
  return 'OTHER';
};

async function allocateTenDrawRotationRecipe(
  tx: TxClient
): Promise<(typeof TEN_DRAW_ROTATION_RECIPES)[number]> {
  const rows = await tx.$queryRaw<Array<{ tenDrawCount: bigint | number | string }>>`
    UPDATE "LotteryTenDrawCounter"
    SET "tenDrawCount" = "tenDrawCount" + 1
    WHERE "id" = ${TEN_DRAW_COUNTER_ROW_ID}
    RETURNING "tenDrawCount"
  `;
  const rawCount = rows[0]?.tenDrawCount;
  const drawCount = typeof rawCount === 'bigint' ? Number(rawCount) : Number(rawCount ?? NaN);
  if (!Number.isFinite(drawCount) || drawCount <= 0) {
    throw new Error('LOTTERY_TEN_DRAW_COUNTER_INVALID');
  }
  const recipeIdx = (drawCount - 1) % TEN_DRAW_ROTATION_RECIPES.length;
  return TEN_DRAW_ROTATION_RECIPES[recipeIdx];
}

async function consumeLotteryCouponVoucherTx(
  tx: TxClient,
  params: {
    couponId: string;
    jinleeId: string;
    ownerDiscordUserId: string | null;
    ownerJinleeId: string;
    now: Date;
  }
) {
  const { couponId, jinleeId, ownerDiscordUserId, ownerJinleeId, now } = params;
  const result = await tx.coupon.updateMany({
    where: {
      id: couponId,
      jinleeId,
      type: CouponType.LOTTERY_VOUCHER,
      status: CouponStatus.ACTIVE,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: {
      status: CouponStatus.USED,
      consumedAt: now,
      consumeAmount: DRAW_COST,
      consumeTargetId: ownerDiscordUserId,
      consumeTargetJinleeId: ownerJinleeId,
    },
  });
  return result.count === 1;
}

async function consumeLotteryDrawVoucherTx(
  tx: TxClient,
  params: {
    drawId: string;
    jinleeId: string;
    ownerDiscordUserId: string | null;
    ownerJinleeId: string;
    now: Date;
    requestId?: string;
  }
) {
  const { drawId, jinleeId, ownerDiscordUserId, ownerJinleeId, now, requestId } = params;
  const result = await tx.lotteryDraw.updateMany({
    where: {
      id: drawId,
      jinleeId,
      status: LotteryStatus.UNUSED,
      consumeAt: null,
      expiresAt: { gt: now },
      prize: { name: PRIZE_NAMES.LOTTERY_VOUCHER },
    },
    data: {
      status: LotteryStatus.USED,
      consumeAt: now,
      requestId,
      consumeAmount: DRAW_COST, // 抽奖代金券固定面额
      consumeTargetId: ownerDiscordUserId,
      consumeTargetJinleeId: ownerJinleeId,
    },
  });
  return result.count === 1;
}

export async function performLotteryDraw(params: {
  userId: string;
  payerId?: string;
  nonce: string;
  requestId?: string;
  pool?: LotteryPool;
}): Promise<LotteryResult> {
  const { userId, payerId = userId, nonce, requestId, pool } = params;
  const now = new Date();
  let spentCharged = false;
  let payerDiscordForRoleSync: string | null = null;
  const result = await prisma.$transaction(async (tx) => {
    const ownerIdentity = await ensureJinleeIdentityForDiscordTx(tx, userId);
    const payerIdentity =
      payerId === userId ? ownerIdentity : await ensureJinleeIdentityForDiscordTx(tx, payerId);
    payerDiscordForRoleSync = payerIdentity.discordUserId ?? null;
    await lockJinleeUserForUpdateTx(tx, payerIdentity.jinleeId);

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
      where: { jinleeId: payerIdentity.jinleeId, status: LotteryStatus.UNUSED, expiresAt: { lte: now } },
      data: { status: LotteryStatus.EXPIRED },
    });

    // 抽奖代金券：优先使用 coupon 表
    await tx.coupon.updateMany({
      where: {
        jinleeId: payerIdentity.jinleeId,
        type: CouponType.LOTTERY_VOUCHER,
        status: CouponStatus.ACTIVE,
        expiresAt: { lte: now },
      },
      data: { status: CouponStatus.EXPIRED },
    });
    let useFreeVoucher = false;
    while (true) {
      const couponVoucher = await tx.coupon.findFirst({
        where: {
          jinleeId: payerIdentity.jinleeId,
          type: CouponType.LOTTERY_VOUCHER,
          status: CouponStatus.ACTIVE,
          expiresAt: { gt: now },
        },
        orderBy: { issuedAt: 'asc' },
        select: { id: true },
      });
      if (couponVoucher) {
        if (
          await consumeLotteryCouponVoucherTx(tx, {
            couponId: couponVoucher.id,
            jinleeId: payerIdentity.jinleeId,
            ownerDiscordUserId: ownerIdentity.discordUserId ?? null,
            ownerJinleeId: ownerIdentity.jinleeId,
            now,
          })
        ) {
          useFreeVoucher = true;
          break;
        }
        continue;
      }

      // 抽奖代金券：按最早优先，如果存在则免扣款
      const freeVoucher = await tx.lotteryDraw.findFirst({
        where: {
          jinleeId: payerIdentity.jinleeId,
          status: LotteryStatus.UNUSED,
          consumeAt: null,
          expiresAt: { gt: now },
          prize: { name: PRIZE_NAMES.LOTTERY_VOUCHER },
        },
        orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      if (!freeVoucher) break;

      if (
        await consumeLotteryDrawVoucherTx(tx, {
          drawId: freeVoucher.id,
          jinleeId: payerIdentity.jinleeId,
          ownerDiscordUserId: ownerIdentity.discordUserId ?? null,
          ownerJinleeId: ownerIdentity.jinleeId,
          now,
          requestId,
        })
      ) {
        useFreeVoucher = true;
        break;
      }
    }

    if (ownerIdentity.discordUserId) {
      await ensureJinleeIdentityForDiscordTx(tx, ownerIdentity.discordUserId);
    }
    if (payerIdentity.discordUserId && payerIdentity.discordUserId !== ownerIdentity.discordUserId) {
      await ensureJinleeIdentityForDiscordTx(tx, payerIdentity.discordUserId);
    }

    if (!useFreeVoucher) {
      spentCharged = true;
      await chargeLotteryCostTx(tx, { payerIdentity, amount: DRAW_COST, now });
    }

    const picked = await pickAndConsumePrize(tx, pool ? { pool } : undefined);
    await maybeAlertSpecialLowStock(tx, picked);

    const randomVal = Math.random();
    const kind = resolvePrizeKind(picked);
    const expiresAt = voucherExpiresAt(kind, now);
    const code = generateCode(kind);
    const cost = useFreeVoucher ? new Prisma.Decimal(0) : DRAW_COST;

    const draw = await tx.lotteryDraw.create({
      data: {
        nonce,
        requestId,
        userId: ownerIdentity.discordUserId ?? null,
        jinleeId: ownerIdentity.jinleeId,
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

    return {
      drawId: draw.id,
      prize: draw.prize as PrizeLike,
      pool: draw.pool,
      random: draw.random ?? randomVal,
      cost: draw.cost,
    };
  });
  if (spentCharged && payerDiscordForRoleSync) {
    scheduleSpentRoleSync(payerDiscordForRoleSync, { announceVipUpgrade: true });
  }
  return result;
}

export async function performLotteryTenDraw(params: {
  userId: string;
  payerId?: string;
  nonce: string;
  requestId?: string;
}): Promise<LotteryBatchResult> {
  const { userId, payerId = userId, nonce, requestId } = params;
  const now = new Date();
  let spentCharged = false;
  let payerDiscordForRoleSync: string | null = null;

  const result = await prisma.$transaction(async (tx) => {
    const ownerIdentity = await ensureJinleeIdentityForDiscordTx(tx, userId);
    const payerIdentity =
      payerId === userId ? ownerIdentity : await ensureJinleeIdentityForDiscordTx(tx, payerId);
    payerDiscordForRoleSync = payerIdentity.discordUserId ?? null;
    await lockJinleeUserForUpdateTx(tx, payerIdentity.jinleeId);

    const existing = await tx.lotteryDraw.findMany({
      where: { nonce: { startsWith: `${nonce}:` } },
      include: { prize: true },
      orderBy: { nonce: 'asc' },
    });
    if (existing.length === 10) {
      return {
        draws: existing.map((draw) => {
          if (!draw.prize) throw new LotteryError('MISSING_PRIZE');
          return {
            drawId: draw.id,
            prize: draw.prize as PrizeLike,
            pool: draw.pool,
            random: draw.random ?? Math.random(),
            cost: new Prisma.Decimal(draw.cost ?? 0),
          };
        }),
        cost: existing.reduce((sum, draw) => sum.add(new Prisma.Decimal(draw.cost ?? 0)), new Prisma.Decimal(0)),
      };
    }

    if (ownerIdentity.discordUserId) {
      await ensureJinleeIdentityForDiscordTx(tx, ownerIdentity.discordUserId);
    }
    if (payerIdentity.discordUserId && payerIdentity.discordUserId !== ownerIdentity.discordUserId) {
      await ensureJinleeIdentityForDiscordTx(tx, payerIdentity.discordUserId);
    }

    spentCharged = true;
    await chargeLotteryCostTx(tx, { payerIdentity, amount: TEN_DRAW_COST, now });

    const recipe = await allocateTenDrawRotationRecipe(tx);
    const drawPlans: Array<{ kind: 'normal' | 'butterfly' | 'random' }> = [
      ...Array.from({ length: recipe.normal }, () => ({ kind: 'normal' as const })),
      ...Array.from({ length: recipe.butterfly }, () => ({ kind: 'butterfly' as const })),
      ...Array.from({ length: recipe.random }, () => ({ kind: 'random' as const })),
    ];

    // Keep the 10 slots visually random while preserving the configured counts.
    for (let idx = drawPlans.length - 1; idx > 0; idx -= 1) {
      const swapIdx = Math.floor(Math.random() * (idx + 1));
      const current = drawPlans[idx];
      drawPlans[idx] = drawPlans[swapIdx];
      drawPlans[swapIdx] = current;
    }

    const draws: LotteryResult[] = [];
    for (let idx = 0; idx < drawPlans.length; idx += 1) {
      const plan = drawPlans[idx];
      const picked =
        plan.kind === 'normal'
          ? await pickAndConsumePrize(tx, { pool: LotteryPool.NORMAL })
          : plan.kind === 'butterfly'
            ? await pickAndConsumePrize(tx, { prizeNames: [TEN_DRAW_FIXED_PRIZE_NAME] })
            : await pickAndConsumePrize(tx);
      await maybeAlertSpecialLowStock(tx, picked);
      const kind = resolvePrizeKind(picked);
      const drawNonce = `${nonce}:${String(idx + 1).padStart(2, '0')}`;
      const randomVal = Math.random();
      const draw = await tx.lotteryDraw.create({
        data: {
          nonce: drawNonce,
          requestId,
          userId: ownerIdentity.discordUserId ?? null,
          jinleeId: ownerIdentity.jinleeId,
          pool: picked.pool,
          prizeId: picked.id,
          cost: idx === 0 ? TEN_DRAW_COST : new Prisma.Decimal(0),
          random: randomVal,
          expiresAt: voucherExpiresAt(kind, now) ?? undefined,
          code: generateCode(kind),
        },
        include: { prize: true },
      });
      if (!draw.prize) throw new LotteryError('MISSING_PRIZE');
      draws.push({
        drawId: draw.id,
        prize: draw.prize as PrizeLike,
        pool: draw.pool,
        random: draw.random ?? randomVal,
        cost: draw.cost,
      });
    }

    return {
      draws,
      cost: TEN_DRAW_COST,
    };
  });

  if (spentCharged && payerDiscordForRoleSync) {
    scheduleSpentRoleSync(payerDiscordForRoleSync, { announceVipUpgrade: true });
  }
  return result;
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
