import { Client, EmbedBuilder } from 'discord.js';
import { Prisma, PrismaClient, RedEnvelopeStatus } from '@prisma/client';
import prisma from '../db/prisma.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { suppressRechargeNotifications } from './rechargeNotifyConfig.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

const MIN_SLICE = new Prisma.Decimal('0.10'); // 单份最小 0.1 元
const FAIRNESS_ALPHA = 1; // 越小越刺激，允许更大落差
// 默认 30 分钟过期，未抢完金额自动退回（可通过 RED_ENVELOPE_EXPIRE_MS 覆盖）
const DEFAULT_EXPIRE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.RED_ENVELOPE_EXPIRE_MS ?? '', 10) || 30 * 60_000
);
const LEDGER_COUNTERPART_ID = 'red-envelope-pool';
const RED_ENVELOPE_IMAGE_URL =
  'https://cdn.discordapp.com/attachments/1445864521343439019/1445864697013211351/1.png?ex=6931e5ee&is=6930946e&hm=87e2bd7bc8ba1865a674d9af6197eeeaa5b5dc96431f9a40b6c80cf12446db4b';
export const CLAIM_EMOJI_ID = '1438676013860257943';
export const CLAIM_EMOJI = '<:_001_:1438676013860257943>';

const timers = new Map<string, NodeJS.Timeout>();
const claimedByEnvelope = new Map<string, Map<string, Prisma.Decimal>>(); // de-dupe per session (stores net credited)
const claimLogByEnvelope = new Map<
  string,
  Array<{
    userId: string;
    displayName?: string;
    amount: Prisma.Decimal;
  }>
>();
const fairSharePlans = new Map<string, Prisma.Decimal[]>(); // deterministic fair split per envelope

const asDecimal = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

type EnvelopeForDisplay = {
  id: string;
  creatorId: string;
  creatorDisplayName?: string | null;
  totalAmount: Prisma.Decimal;
  totalCount: number;
  remainingCount: number;
  status: RedEnvelopeStatus;
  expiresAt: Date;
  note?: string | null;
  refundedAmount?: Prisma.Decimal | null;
};

const clampNote = (note?: string | null) => {
  if (!note) return undefined;
  return note.trim().slice(0, 120);
};

const sanitizeName = (name?: string | null) => {
  if (!name) return undefined;
  const cleaned = name.replace(/<@!?\d+>/g, '').trim();
  return cleaned || undefined;
};

const hashToSeed = (input: string) => {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
};

const mulberry32 = (seed: number) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffleWithRng = <T>(list: T[], rng: () => number) => {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const sampleGammaIntShape = (shape: number, rng: () => number) => {
  let sum = 0;
  for (let i = 0; i < shape; i += 1) {
    const u = Math.max(rng(), Number.EPSILON);
    sum += -Math.log(u);
  }
  return Math.max(sum, Number.EPSILON);
};

const fixRounding = (shares: Prisma.Decimal[], targetTotal: Prisma.Decimal) => {
  const sum = shares.reduce((acc, s) => acc.add(s), new Prisma.Decimal(0));
  const diff = targetTotal.sub(sum);
  let cents = Math.round(Number(diff.toString()) * 100);
  if (!Number.isFinite(cents) || cents === 0) return shares;

  const direction = cents > 0 ? 1 : -1;
  let idx = 0;
  const delta = new Prisma.Decimal((direction / 100).toFixed(2));
  while (cents !== 0 && idx < shares.length * 3) {
    const i = idx % shares.length;
    const next = shares[i].add(delta);
    if (next.gte(MIN_SLICE)) {
      shares[i] = next;
      cents -= direction;
    }
    idx += 1;
  }
  return shares;
};

const generateFairShares = (
  seedKey: string,
  totalAmount: Prisma.Decimal,
  count: number
) => {
  if (count <= 0) return [] as Prisma.Decimal[];
  const minTotal = MIN_SLICE.mul(count);
  const variablePool = totalAmount.sub(minTotal);
  if (variablePool.lte(0)) {
    return new Array(count).fill(MIN_SLICE);
  }

  const rng = mulberry32(hashToSeed(seedKey));
  const weights: number[] = [];
  for (let i = 0; i < count; i += 1) {
    weights.push(sampleGammaIntShape(FAIRNESS_ALPHA, rng));
  }
  if (weights.length) {
    const koiHits = rng() < 0.6 ? 1 + (rng() < 0.3 ? 1 : 0) : 0; // 0/1/2 个加成
    const used = new Set<number>();
    for (let k = 0; k < koiHits; k += 1) {
      const koiIndex = Math.floor(rng() * weights.length);
      if (used.has(koiIndex)) continue;
      used.add(koiIndex);
      const koiBoost = 1.5 + rng() * 1.5; // 1.5x - 3.0x
      weights[koiIndex] *= koiBoost;
    }
  }
  const weightSum = weights.reduce((acc, w) => acc + w, 0) || Number.EPSILON;

  let shares = weights.map((w) => {
    const portion = variablePool.mul(w).div(weightSum);
    const raw = MIN_SLICE.add(portion);
    return new Prisma.Decimal(raw.toFixed(2));
  });

  if (shares.length >= 2) {
    const applyBump = rng() < 0.5;
    if (applyBump) {
      const target = Math.floor(rng() * shares.length);
      const availablePool = shares.reduce((acc, s, idx) => {
        if (idx === target) return acc;
        const spare = s.sub(MIN_SLICE);
        return spare.gt(0) ? acc.add(spare) : acc;
      }, new Prisma.Decimal(0));
      const bumpMax = Math.min(3, Number(availablePool.toString())); // 单次最多挪 3 元
      if (bumpMax > 0.01) {
        const rawBump = bumpMax * (0.5 + rng() * 0.7); // 50%-120% of cap
        const cappedBump = Math.min(bumpMax, Math.max(0.1, rawBump));
        const bump = new Prisma.Decimal(cappedBump.toFixed(2));
        if (bump.gt(0)) {
          let remaining = bump;
          for (let i = 0; i < shares.length && remaining.gt(0); i += 1) {
            if (i === target) continue;
            const spare = shares[i].sub(MIN_SLICE);
            if (spare.lte(0)) continue;
            const take = spare.gte(remaining) ? remaining : spare;
            shares[i] = shares[i].sub(take);
            remaining = remaining.sub(take);
          }
          shares[target] = shares[target].add(bump.sub(remaining));
        }
      }
    }
  }

  shares = fixRounding(shares, totalAmount);
  shares = shuffleWithRng(shares, rng);
  return shares;
};

const getFairSharePlan = (envelope: {
  id: string;
  totalAmount: Prisma.Decimal;
  totalCount: number;
  remainingAmount: Prisma.Decimal;
  remainingCount: number;
}) => {
  const claimedCount = envelope.totalCount - envelope.remainingCount;
  let plan = fairSharePlans.get(envelope.id);
  if (!plan) {
    plan = generateFairShares(envelope.id, envelope.totalAmount, envelope.totalCount);
  }

  const tail = plan.slice(claimedCount);
  const tailSum = tail.reduce((acc, s) => acc.add(s), new Prisma.Decimal(0));
  const diff = tailSum.sub(envelope.remainingAmount).abs();
  if (diff.gte(new Prisma.Decimal('0.01'))) {
    const rebuiltTail = generateFairShares(
      `${envelope.id}-tail-${claimedCount}`,
      envelope.remainingAmount,
      envelope.remainingCount
    );
    plan = [...plan.slice(0, claimedCount), ...rebuiltTail];
  }

  fairSharePlans.set(envelope.id, plan);
  return plan;
};

const pickFairShare = (
  envelope: {
    id: string;
    totalAmount: Prisma.Decimal;
    totalCount: number;
    remainingAmount: Prisma.Decimal;
    remainingCount: number;
  }
) => {
  if (envelope.remainingCount <= 1) return envelope.remainingAmount;
  const minForOthers = MIN_SLICE.mul(envelope.remainingCount - 1);
  const maxShare = envelope.remainingAmount.sub(minForOthers);
  if (maxShare.lte(MIN_SLICE)) return MIN_SLICE;

  const plan = getFairSharePlan(envelope);
  const idx = envelope.totalCount - envelope.remainingCount;
  const planned = plan[idx];
  if (!planned) return maxShare;

  if (planned.gt(maxShare)) return maxShare;
  if (planned.lt(MIN_SLICE)) return MIN_SLICE;
  return planned;
};

function splitFromPools(
  amount: Prisma.Decimal,
  incomePool: Prisma.Decimal,
  rechargePool: Prisma.Decimal
) {
  const totalPool = incomePool.add(rechargePool);
  if (totalPool.lte(0)) {
    return { incomePart: new Prisma.Decimal(0), rechargePart: amount };
  }
  const incomePart = amount.mul(incomePool).div(totalPool);
  const cappedIncome =
    incomePart.gt(incomePool) ? incomePool : new Prisma.Decimal(incomePart.toFixed(4));
  const rechargePart = amount.sub(cappedIncome);
  return { incomePart: cappedIncome, rechargePart };
}

const formatAmount = (d: Prisma.Decimal | number | string) =>
  Number(new Prisma.Decimal(d).toString()).toFixed(2);

function getClaimLog(envelopeId: string) {
  return claimLogByEnvelope.get(envelopeId) ?? [];
}

function pushClaimLog(
  envelopeId: string,
  entry: {
    userId: string;
    displayName?: string;
    amount: Prisma.Decimal;
  }
) {
  const list = claimLogByEnvelope.get(envelopeId) ?? [];
  list.push(entry);
  claimLogByEnvelope.set(envelopeId, list);
}

export function buildRedEnvelopeMessagePayload(envelope: EnvelopeForDisplay) {
  const creatorLabel = envelope.creatorDisplayName ?? '红包发起人';
  const embed = new EmbedBuilder()
    .setColor(0xffc28b)
    .setTitle(`🧧 ${creatorLabel} 发了一个红包啦`)
    .setDescription(
      [
        `总额：¥${formatAmount(envelope.totalAmount)} | 份数：${envelope.totalCount}`,
        `留言：${envelope.note ?? '锦鲤附体，好运暴击！'}`,
        `点击下方表情 ${CLAIM_EMOJI} 抢红包！`,
      ].join('\n')
    )
    .setImage(RED_ENVELOPE_IMAGE_URL);

  const claims = getClaimLog(envelope.id);
  if (claims.length) {
    const lines = claims
      .slice(-50)
      .map(
        (c) =>
          `${c.displayName ?? '用户'} 抢到 ¥${formatAmount(c.amount)}`
      );
    embed.addFields({ name: '已抢', value: lines.join('\n') });
  }

  if (envelope.status === RedEnvelopeStatus.FINISHED && claims.length) {
    const top = claims.reduce((best, cur) =>
      cur.amount.gt(best.amount) ? cur : best
    );
    const koiName = sanitizeName(top.displayName) ?? '用户';
    const koiLine = `${CLAIM_EMOJI} 恭喜锦鲤宝宝 ${koiName} 抢到了最高金额 ¥${formatAmount(top.amount)}`;
    embed.addFields({ name: '锦鲤', value: koiLine });
  }

  if (envelope.status === RedEnvelopeStatus.FINISHED) {
    embed.setFooter({ text: '红包已抢完 🎉' });
  } else if (envelope.status === RedEnvelopeStatus.REFUNDED) {
    const refunded = envelope.refundedAmount ? formatAmount(envelope.refundedAmount) : '0.00';
    embed.setFooter({ text: `红包已过期，退回 ¥${refunded}` });
  }

  return {
    embeds: [embed],
  };
}

export type ClaimResult =
  | {
      status: 'claimed';
      amount: Prisma.Decimal; // net amount
      gross: Prisma.Decimal; // raw share before commission
      finished: boolean;
      envelopeId: string;
    }
  | {
      status: 'already_claimed';
      amount: Prisma.Decimal;
      finished: boolean;
      envelopeId: string;
    }
  | { status: 'expired'; envelopeId?: string; refundAmount?: Prisma.Decimal }
  | { status: 'ended'; envelopeId?: string }
  | { status: 'not_found' };

export type CreateEnvelopeParams = {
  creatorId: string;
  totalAmount: Prisma.Decimal | number | string;
  count: number;
  note?: string;
  channelId?: string;
  expiresAt?: Date;
};

async function ensureMemberExists(tx: DbClient, discordUserId: string) {
  await tx.member.upsert({
    where: { discordUserId },
    create: { discordUserId },
    update: {},
  });
}

export async function createRedEnvelope(
  params: CreateEnvelopeParams,
  client: PrismaClient = prisma
) {
  const totalAmount = asDecimal(params.totalAmount);
  if (totalAmount.lte(0)) {
    throw new Error('金额必须大于 0。');
  }
  if (!Number.isInteger(params.count) || params.count <= 0) {
    throw new Error('份数必须为正整数。');
  }
  const minTotal = MIN_SLICE.mul(params.count);
  if (totalAmount.lt(minTotal)) {
    throw new Error(`总金额不足，每份至少 ¥${MIN_SLICE.toString()}`);
  }

  const expiresAt =
    params.expiresAt ??
    new Date(Date.now() + DEFAULT_EXPIRE_MS);

  return client.$transaction(async (tx) => {
    await ensureMemberExists(tx, params.creatorId);

    const member = await tx.member.findUnique({
      where: { discordUserId: params.creatorId },
      select: { income: true, recharge: true, totalBalance: true, totalSpent: true },
    });
    if (!member) throw new Error('未找到用户。');

    let incomePool = asDecimal(member.income ?? 0);
    let rechargePool = asDecimal(member.recharge ?? 0);
    const totalBalance = asDecimal(member.totalBalance ?? 0);
    const knownPool = incomePool.add(rechargePool);
    const maxAvailable = knownPool.gt(totalBalance) ? knownPool : totalBalance;
    if (maxAvailable.lt(totalAmount)) {
      throw new Error('余额不足，无法发红包。');
    }

    if (knownPool.lt(totalAmount)) {
      const missing = totalAmount.sub(knownPool);
      const extra = totalBalance.sub(knownPool);
      if (extra.lt(missing)) {
        throw new Error('余额不足，无法发红包。');
      }
      rechargePool = rechargePool.add(missing);
    }

    const split = splitIncomeRecharge(incomePool, rechargePool, totalAmount);

    const incomeAfter = incomePool.sub(split.fromIncome);
    const rechargeAfter = rechargePool.sub(split.fromRecharge);
    const totalBalanceAfter = incomeAfter.add(rechargeAfter);

    const updatedMember = await tx.member.update({
      where: { discordUserId: params.creatorId },
      data: {
        income: incomeAfter,
        recharge: rechargeAfter,
        totalBalance: totalBalanceAfter,
        totalSpent: { increment: totalAmount },
      },
      select: { totalBalance: true },
    });

    const peiwanRecord = await tx.pEIWAN.findUnique({
      where: { discordUserId: params.creatorId },
      select: { PEIWANID: true },
    });
    if (peiwanRecord) {
      await tx.pEIWAN.update({
        where: { discordUserId: params.creatorId },
        data: { balance: updatedMember.totalBalance },
      });
    }

    await recordIndividualTransaction(tx, {
      discordId: params.creatorId,
      thirdPartydiscordId: LEDGER_COUNTERPART_ID,
      balanceBefore: split.totalBefore,
      amountChange: totalAmount,
      balanceAfter: split.totalAfter,
      typeOfTransaction: '红包发出',
    });

    const envelope = await tx.redEnvelope.create({
      data: {
        creatorId: params.creatorId,
        totalAmount,
        remainingAmount: totalAmount,
        totalCount: params.count,
        remainingCount: params.count,
        note: clampNote(params.note),
        status: RedEnvelopeStatus.ACTIVE,
        expiresAt,
        channelId: params.channelId,
        incomePool: split.fromIncome,
        rechargePool: split.fromRecharge,
      },
    });

    return envelope;
  });
}

export async function bindEnvelopeMessage(
  envelopeId: string,
  payload: { messageId: string; channelId: string },
  client: PrismaClient = prisma
) {
  await client.redEnvelope.update({
    where: { id: envelopeId },
    data: {
      messageId: payload.messageId,
      channelId: payload.channelId,
    },
  });
}

export async function findEnvelopeByMessage(messageId: string) {
  return prisma.redEnvelope.findFirst({
    where: { messageId },
    select: {
      id: true,
      status: true,
    },
  });
}

export async function claimRedEnvelope(
  envelopeId: string,
  claimerId: string,
  displayName?: string,
  client: PrismaClient = prisma
): Promise<ClaimResult> {
  const getClaimed = (envId: string, userId: string) => {
    const m = claimedByEnvelope.get(envId);
    if (!m) return null;
    return m.get(userId) ?? null;
  };
  const setClaimed = (envId: string, userId: string, amount: Prisma.Decimal) => {
    let m = claimedByEnvelope.get(envId);
    if (!m) {
      m = new Map();
      claimedByEnvelope.set(envId, m);
    }
    m.set(userId, amount);
  };

  return client.$transaction(async (tx) => {
    // lock the envelope row to avoid concurrent over-claims
    await tx.$queryRaw`SELECT 1 FROM "RedEnvelope" WHERE id = ${envelopeId} FOR UPDATE`;

    const envelope = await tx.redEnvelope.findUnique({
      where: { id: envelopeId },
    });
    if (!envelope) return { status: 'not_found' };

    if (envelope.status !== RedEnvelopeStatus.ACTIVE || envelope.remainingCount <= 0) {
      return { status: 'ended', envelopeId: envelope.id };
    }

    if (envelope.expiresAt.getTime() <= Date.now()) {
      const expired = await expireEnvelope(envelope.id, tx);
      return { status: 'expired', envelopeId: envelope.id, refundAmount: expired.refundAmount };
    }

    const existing = getClaimed(envelope.id, claimerId);
    if (existing) {
      return {
        status: 'already_claimed',
        amount: existing,
        finished: envelope.remainingCount <= 0,
        envelopeId: envelope.id,
      };
    }

    const remainingAmount = asDecimal(envelope.remainingAmount ?? 0);
    if (envelope.remainingCount <= 0 || remainingAmount.lte(0)) {
      await tx.redEnvelope.update({
        where: { id: envelope.id },
        data: { status: RedEnvelopeStatus.FINISHED, remainingCount: 0, remainingAmount: 0 },
      });
      return { status: 'ended', envelopeId: envelope.id };
    }

    const share = pickFairShare({
      id: envelope.id,
      totalAmount: asDecimal(envelope.totalAmount ?? 0),
      totalCount: envelope.totalCount,
      remainingAmount,
      remainingCount: envelope.remainingCount,
    });
    const { incomePart, rechargePart } = splitFromPools(
      share,
      asDecimal(envelope.incomePool ?? 0),
      asDecimal(envelope.rechargePool ?? 0)
    );

    const remainingCountAfter = envelope.remainingCount - 1;
    const updatedEnvelope = await tx.redEnvelope.update({
      where: { id: envelope.id },
      data: {
        remainingAmount: { decrement: share },
        remainingCount: { decrement: 1 },
        incomePool: { decrement: incomePart },
        rechargePool: { decrement: rechargePart },
        status: remainingCountAfter <= 0 ? RedEnvelopeStatus.FINISHED : RedEnvelopeStatus.ACTIVE,
      },
      select: {
        id: true,
        remainingCount: true,
        remainingAmount: true,
        status: true,
        creatorId: true,
      },
    });

    await ensureMemberExists(tx, claimerId);
    const member = await tx.member.findUnique({
      where: { discordUserId: claimerId },
      select: { totalBalance: true, income: true, recharge: true, commissionRate: true },
    });
    const balanceBefore = new Prisma.Decimal(member?.totalBalance ?? 0);
    const rate = member?.commissionRate
      ? new Prisma.Decimal(member.commissionRate)
      : new Prisma.Decimal(1);
    const netAmount = new Prisma.Decimal(share.mul(rate).toFixed(2));
    const balanceAfter = balanceBefore.add(netAmount);

    await tx.member.update({
      where: { discordUserId: claimerId },
      data: {
        income: { increment: netAmount },
        totalBalance: { increment: netAmount },
      },
    });

    const peiwan = await tx.pEIWAN.findUnique({
      where: { discordUserId: claimerId },
      select: { PEIWANID: true, totalEarn: true },
    });
    if (peiwan) {
      await tx.pEIWAN.update({
        where: { discordUserId: claimerId },
        data: {
          balance: balanceAfter,
          totalEarn: new Prisma.Decimal(peiwan.totalEarn ?? 0).add(netAmount),
        },
      });
    }

    await recordIndividualTransaction(tx, {
      discordId: claimerId,
      thirdPartydiscordId: envelope.creatorId,
      balanceBefore,
      amountChange: netAmount,
      balanceAfter,
      typeOfTransaction: '红包收入',
    });

    pushClaimLog(envelope.id, { userId: claimerId, displayName, amount: share });
    setClaimed(envelope.id, claimerId, netAmount);

    if (updatedEnvelope.status !== RedEnvelopeStatus.ACTIVE) {
      clearExpirationTimer(envelope.id);
      claimedByEnvelope.delete(envelope.id);
      fairSharePlans.delete(envelope.id);
    }

    return {
      status: 'claimed',
      amount: netAmount,
      gross: share,
      finished: updatedEnvelope.status !== RedEnvelopeStatus.ACTIVE,
      envelopeId: envelope.id,
    };
  });
}

export async function expireEnvelope(
  envelopeId: string,
  client: DbClient = prisma
): Promise<{ refundAmount: Prisma.Decimal; status: 'refunded' | 'noop' | 'not_due'; creatorId?: string }> {
  const runner = typeof (client as any).$transaction === 'function'
    ? (client as PrismaClient).$transaction.bind(client as PrismaClient)
    : async (fn: (tx: DbClient) => any) => fn(client);

  return runner(async (tx: DbClient) => {
    const envelope = await tx.redEnvelope.findUnique({
      where: { id: envelopeId },
      select: {
        id: true,
        creatorId: true,
        status: true,
        expiresAt: true,
        remainingAmount: true,
        incomePool: true,
        rechargePool: true,
      },
    });
    if (!envelope) return { refundAmount: new Prisma.Decimal(0), status: 'noop' };
    if (envelope.status !== RedEnvelopeStatus.ACTIVE) {
      return { refundAmount: new Prisma.Decimal(0), status: 'noop', creatorId: envelope.creatorId };
    }
    if (envelope.expiresAt.getTime() > Date.now()) {
      return { refundAmount: new Prisma.Decimal(0), status: 'not_due', creatorId: envelope.creatorId };
    }

    const remainingAmount = asDecimal(envelope.remainingAmount ?? 0);
    const refundRecharge = remainingAmount; // 退回到老板的充值余额

    await tx.redEnvelope.update({
      where: { id: envelope.id },
      data: {
        status: RedEnvelopeStatus.REFUNDED,
        remainingAmount: new Prisma.Decimal(0),
        remainingCount: 0,
        incomePool: new Prisma.Decimal(0),
        rechargePool: new Prisma.Decimal(0),
        refundedAmount: remainingAmount,
      },
    });

    if (remainingAmount.gt(0)) {
      const member = await tx.member.findUnique({
        where: { discordUserId: envelope.creatorId },
        select: { totalBalance: true },
      });
        if (member) {
        await suppressRechargeNotifications(tx);

        const balanceBefore = new Prisma.Decimal(member.totalBalance ?? 0);
        const balanceAfter = balanceBefore.add(remainingAmount);

          await tx.member.update({
            where: { discordUserId: envelope.creatorId },
            data: {
              recharge: { increment: refundRecharge },
              totalBalance: { increment: remainingAmount },
              totalSpent: { decrement: remainingAmount },
            },
          });

        const peiwan = await tx.pEIWAN.findUnique({
          where: { discordUserId: envelope.creatorId },
          select: { PEIWANID: true },
        });
        if (peiwan) {
          await tx.pEIWAN.update({
            where: { discordUserId: envelope.creatorId },
            data: { balance: balanceAfter },
          });
        }

        await recordIndividualTransaction(tx, {
          discordId: envelope.creatorId,
          thirdPartydiscordId: LEDGER_COUNTERPART_ID,
          balanceBefore,
          amountChange: remainingAmount,
          balanceAfter,
          typeOfTransaction: '红包退回',
        });
      }
    }

    clearExpirationTimer(envelope.id);
    claimedByEnvelope.delete(envelope.id);
    claimLogByEnvelope.delete(envelope.id);
    fairSharePlans.delete(envelope.id);

    return { refundAmount: remainingAmount, status: 'refunded', creatorId: envelope.creatorId };
  });
}

async function resolveCreatorName(
  client: Client,
  creatorId: string,
  channelId?: string | null
): Promise<string | undefined> {
  try {
    if (channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel && channel.isTextBased() && 'guild' in channel && channel.guild) {
        const member =
          channel.guild.members.cache.get(creatorId) ??
          (await channel.guild.members.fetch(creatorId).catch(() => null));
        if (member?.displayName) return sanitizeName(member.displayName);
      }
    }
    const user = await client.users.fetch(creatorId).catch(() => null);
    return sanitizeName(user?.username);
  } catch {
    return undefined;
  }
}

export async function refreshRedEnvelopeMessage(client: Client, envelopeId: string) {
  const envelope = await prisma.redEnvelope.findUnique({
    where: { id: envelopeId },
    select: {
      id: true,
      creatorId: true,
      totalAmount: true,
      totalCount: true,
      remainingCount: true,
      status: true,
      expiresAt: true,
      note: true,
      refundedAmount: true,
      channelId: true,
      messageId: true,
    },
  });
  if (!envelope?.channelId || !envelope.messageId) return;

  try {
    const channel = await client.channels.fetch(envelope.channelId);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(envelope.messageId);
    const creatorDisplayName = await resolveCreatorName(client, envelope.creatorId, envelope.channelId);
    const payload = buildRedEnvelopeMessagePayload({ ...envelope, creatorDisplayName });
    await message.edit(payload);
  } catch (err) {
    console.error('[red-envelope] refresh message failed:', err);
  }
}

function clearExpirationTimer(envelopeId: string) {
  const timer = timers.get(envelopeId);
  if (timer) clearTimeout(timer);
  timers.delete(envelopeId);
}

async function runExpiration(client: Client, envelopeId: string) {
  try {
    const result = await expireEnvelope(envelopeId);
    if (result.status === 'refunded') {
      await refreshRedEnvelopeMessage(client, envelopeId);
      if (result.creatorId) {
        const refundText = Number(result.refundAmount.toString()).toFixed(2);
        try {
          const user = await client.users.fetch(result.creatorId);
          await user.send(`您的红包已过期，已给您返回金额 ¥${refundText}`);
        } catch (err) {
          console.error('[red-envelope] refund notify failed:', err);
        }
      }
    }
  } catch (err) {
    console.error('[red-envelope] expire failed:', err);
  }
}

export function scheduleRedEnvelopeExpiration(
  client: Client,
  envelope: { id: string; expiresAt: Date }
) {
  clearExpirationTimer(envelope.id);
  const delay = envelope.expiresAt.getTime() - Date.now();
  if (delay <= 0) {
    runExpiration(client, envelope.id);
    return;
  }
  const timer = setTimeout(() => runExpiration(client, envelope.id), delay);
  timers.set(envelope.id, timer);
}

export async function recoverRedEnvelopeSchedules(client: Client) {
  const actives = await prisma.redEnvelope.findMany({
    where: { status: RedEnvelopeStatus.ACTIVE },
    select: { id: true, expiresAt: true },
  });
  for (const env of actives) {
    scheduleRedEnvelopeExpiration(client, env);
  }
}
