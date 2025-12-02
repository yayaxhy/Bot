import { Client, EmbedBuilder } from 'discord.js';
import { Prisma, PrismaClient, RedEnvelopeStatus } from '@prisma/client';
import prisma from '../db/prisma.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { recordIndividualTransaction } from './individualTransactionService.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

const MIN_SLICE = new Prisma.Decimal('0.10'); // 单份最小 0.1 元
// 默认 30 分钟过期，未抢完金额自动退回（可通过 RED_ENVELOPE_EXPIRE_MS 覆盖）
const DEFAULT_EXPIRE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.RED_ENVELOPE_EXPIRE_MS ?? '', 10) || 30 * 60_000
);
const LEDGER_COUNTERPART_ID = 'red-envelope-pool';
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

function calcRandomShare(remainingAmount: Prisma.Decimal, remainingCount: number): Prisma.Decimal {
  if (remainingCount <= 1) return remainingAmount;

  const minForOthers = MIN_SLICE.mul(remainingCount - 1);
  const maxShare = remainingAmount.sub(minForOthers);
  if (maxShare.lte(MIN_SLICE)) return MIN_SLICE;

  const random = Math.random();
  const spread = maxShare.sub(MIN_SLICE);
  const candidate = MIN_SLICE.add(spread.mul(random));

  // floor to 2 decimals using number math to avoid rounding up the total
  const floored = Math.floor(Number(candidate.toString()) * 100) / 100;
  const share = new Prisma.Decimal(floored.toFixed(2));

  if (share.lt(MIN_SLICE)) return MIN_SLICE;
  if (share.gt(maxShare)) return maxShare;
  return share;
}

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
    );

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

  if (envelope.status === RedEnvelopeStatus.FINISHED) {
    embed.setFooter({ text: '红包已抢完 🎉' });
  } else if (envelope.status === RedEnvelopeStatus.REFUNDED) {
    const refunded = envelope.refundedAmount ? formatAmount(envelope.refundedAmount) : '0.00';
    embed.setFooter({ text: `红包已过期，退回 ¥${refunded}` });
  }

  return { embeds: [embed] };
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

    const totalBalance = asDecimal(member.totalBalance ?? 0);
    if (totalBalance.lt(totalAmount)) {
      throw new Error('余额不足，无法发红包。');
    }

    const split = splitIncomeRecharge(
      member.income ?? 0,
      member.recharge ?? 0,
      totalAmount
    );

    const updatedMember = await tx.member.update({
      where: { discordUserId: params.creatorId },
      data: {
        income: { decrement: split.fromIncome },
        recharge: { decrement: split.fromRecharge },
        totalBalance: { decrement: totalAmount },
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

    const share = calcRandomShare(remainingAmount, envelope.remainingCount);
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
): Promise<{ refundAmount: Prisma.Decimal; status: 'refunded' | 'noop' | 'not_due' }> {
  const runner = typeof (client as any).$transaction === 'function'
    ? (client as PrismaClient).$transaction.bind(client as PrismaClient)
    : async (fn: (tx: DbClient) => any) => fn(client);

  return runner(async (tx: DbClient) => {
    const envelope = await tx.redEnvelope.findUnique({ where: { id: envelopeId } });
    if (!envelope) return { refundAmount: new Prisma.Decimal(0), status: 'noop' };
    if (envelope.status !== RedEnvelopeStatus.ACTIVE) {
      return { refundAmount: new Prisma.Decimal(0), status: 'noop' };
    }
    if (envelope.expiresAt.getTime() > Date.now()) {
      return { refundAmount: new Prisma.Decimal(0), status: 'not_due' };
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

    return { refundAmount: remainingAmount, status: 'refunded' };
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
