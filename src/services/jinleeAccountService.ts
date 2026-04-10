import { AccountProvider, Prisma, PrismaClient } from '@prisma/client';
import { generateJinleeId } from '../lib/jinleeId.js';

type PrismaClientOrTransaction = Prisma.TransactionClient | PrismaClient;

const DEC = (value: Prisma.Decimal | number | string | null | undefined) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value ?? 0);

const memberWalletSelect = {
  serverDisplayName: true,
  totalBalance: true,
  income: true,
  recharge: true,
  totalSpent: true,
} satisfies Prisma.MemberSelect;

export type JinleeIdentity = {
  jinleeId: string;
  discordUserId: string | null;
};

export class JinleeIdentityNotFoundError extends Error {
  requestedId: string;

  constructor(requestedId: string) {
    super(`jinlee_identity_not_found:${requestedId}`);
    this.name = 'JinleeIdentityNotFoundError';
    this.requestedId = requestedId;
  }
}

type WalletDeltaInput = JinleeIdentity & {
  totalBalanceDelta?: Prisma.Decimal | number | string;
  incomeDelta?: Prisma.Decimal | number | string;
  rechargeDelta?: Prisma.Decimal | number | string;
  totalSpentDelta?: Prisma.Decimal | number | string;
  loyaltyPointsDelta?: Prisma.Decimal | number | string;
  offsetNegativeRechargeWithIncome?: boolean;
};

export const ensureJinleeIdentityForDiscordTx = async (
  client: PrismaClientOrTransaction,
  discordUserId: string,
): Promise<JinleeIdentity> => {
  let member = await client.member.findUnique({
    where: { discordUserId },
    select: memberWalletSelect,
  });

  if (!member) {
    member = await client.member.create({
      data: { discordUserId },
      select: memberWalletSelect,
    });
  }

  const jinleeUser = await client.jinleeUser.upsert({
    where: { discordUserId },
    update: {
      discordUserId,
      ...(member?.serverDisplayName ? { discordDisplayName: member.serverDisplayName } : {}),
      ...(member
        ? {
            totalBalance: member.totalBalance,
            income: member.income,
            recharge: member.recharge,
            totalSpent: member.totalSpent,
          }
        : {}),
    },
    create: {
      jinleeId: generateJinleeId(),
      discordUserId,
      ...(member?.serverDisplayName ? { discordDisplayName: member.serverDisplayName } : {}),
      ...(member
        ? {
            totalBalance: member.totalBalance,
            income: member.income,
            recharge: member.recharge,
            totalSpent: member.totalSpent,
          }
        : {}),
    },
    select: {
      jinleeId: true,
      discordUserId: true,
    },
  });

  await client.accountBinding.upsert({
    where: {
      provider_providerUserId: {
        provider: AccountProvider.DISCORD,
        providerUserId: discordUserId,
      },
    },
    update: {
      jinleeId: jinleeUser.jinleeId,
      lastLoginAt: new Date(),
    },
    create: {
      jinleeId: jinleeUser.jinleeId,
      provider: AccountProvider.DISCORD,
      providerUserId: discordUserId,
      lastLoginAt: new Date(),
    },
  });

  return {
    jinleeId: jinleeUser.jinleeId,
    discordUserId: jinleeUser.discordUserId ?? discordUserId,
  };
};

export const findJinleeIdentityTx = async (
  client: PrismaClientOrTransaction,
  userId: string | null | undefined,
): Promise<JinleeIdentity | null> => {
  const normalized = String(userId ?? '').trim();
  if (!normalized) return null;

  const byJinlee = await client.jinleeUser.findUnique({
    where: { jinleeId: normalized },
    select: { jinleeId: true, discordUserId: true },
  });
  if (byJinlee) {
    return {
      jinleeId: byJinlee.jinleeId,
      discordUserId: byJinlee.discordUserId ?? null,
    };
  }

  const byDiscord = await client.jinleeUser.findUnique({
    where: { discordUserId: normalized },
    select: { jinleeId: true, discordUserId: true },
  });
  if (byDiscord) {
    return {
      jinleeId: byDiscord.jinleeId,
      discordUserId: byDiscord.discordUserId ?? normalized,
    };
  }

  const member = await client.member.findUnique({
    where: { discordUserId: normalized },
    select: { discordUserId: true },
  });
  if (!member) return null;

  return ensureJinleeIdentityForDiscordTx(client, normalized);
};

export const resolveJinleeIdentityTx = findJinleeIdentityTx;

export const requireJinleeIdentityTx = async (
  client: PrismaClientOrTransaction,
  userId: string | null | undefined,
): Promise<JinleeIdentity> => {
  const identity = await findJinleeIdentityTx(client, userId);
  if (!identity) {
    throw new JinleeIdentityNotFoundError(String(userId ?? '').trim());
  }
  return identity;
};

export const isJinleeIdentityNotFoundError = (error: unknown): error is JinleeIdentityNotFoundError =>
  error instanceof JinleeIdentityNotFoundError;

export const lockJinleeUserForUpdateTx = async (
  tx: Prisma.TransactionClient,
  jinleeId: string,
) => {
  await tx.$executeRaw`SELECT 1 FROM "JinleeUser" WHERE "jinleeId" = ${jinleeId} FOR UPDATE`;
};

export const getJinleeWalletSnapshotTx = async (
  client: PrismaClientOrTransaction,
  identity: JinleeIdentity,
) => {
  const jinleeUser = await client.jinleeUser.findUnique({
    where: { jinleeId: identity.jinleeId },
    select: {
      totalBalance: true,
      income: true,
      recharge: true,
      totalSpent: true,
      loyaltyPoints: true,
    },
  });

  if (!jinleeUser) {
    throw new Error(`jinlee_user_not_found:${identity.jinleeId}`);
  }

  if (!identity.discordUserId) {
    return {
      totalBalance: DEC(jinleeUser.totalBalance),
      income: DEC(jinleeUser.income),
      recharge: DEC(jinleeUser.recharge),
      totalSpent: DEC(jinleeUser.totalSpent),
      loyaltyPoints: DEC(jinleeUser.loyaltyPoints),
    };
  }

  const member = await client.member.findUnique({
    where: { discordUserId: identity.discordUserId },
    select: {
      totalBalance: true,
      income: true,
      recharge: true,
      totalSpent: true,
    },
  });

  return {
    totalBalance: DEC(member?.totalBalance ?? jinleeUser.totalBalance),
    income: DEC(member?.income ?? jinleeUser.income),
    recharge: DEC(member?.recharge ?? jinleeUser.recharge),
    totalSpent: DEC(member?.totalSpent ?? jinleeUser.totalSpent),
    loyaltyPoints: DEC(jinleeUser.loyaltyPoints),
  };
};

export const applyJinleeWalletDeltaTx = async (
  tx: Prisma.TransactionClient,
  params: WalletDeltaInput,
) => {
  const totalBalanceDelta = DEC(params.totalBalanceDelta);
  let incomeDelta = DEC(params.incomeDelta);
  let rechargeDelta = DEC(params.rechargeDelta);
  const totalSpentDelta = DEC(params.totalSpentDelta);
  const loyaltyPointsDelta = DEC(params.loyaltyPointsDelta);

  if (params.offsetNegativeRechargeWithIncome && incomeDelta.gt(0) && rechargeDelta.isZero()) {
    const walletBefore = await getJinleeWalletSnapshotTx(tx, {
      jinleeId: params.jinleeId,
      discordUserId: params.discordUserId,
    });

    if (walletBefore.recharge.lt(0)) {
      const maxRechargeOffset = DEC(0).sub(walletBefore.recharge);
      const rechargeOffset = incomeDelta.lt(maxRechargeOffset) ? incomeDelta : maxRechargeOffset;
      incomeDelta = incomeDelta.sub(rechargeOffset);
      rechargeDelta = rechargeDelta.add(rechargeOffset);
    }
  }

  const updatedJinleeUser = await tx.jinleeUser.update({
    where: { jinleeId: params.jinleeId },
    data: {
      totalBalance: { increment: totalBalanceDelta },
      income: { increment: incomeDelta },
      recharge: { increment: rechargeDelta },
      totalSpent: { increment: totalSpentDelta },
      loyaltyPoints: { increment: loyaltyPointsDelta },
    },
    select: {
      totalBalance: true,
      income: true,
      recharge: true,
      totalSpent: true,
      loyaltyPoints: true,
    },
  });

  let updatedMember:
    | {
        totalBalance: Prisma.Decimal;
        income: Prisma.Decimal;
        recharge: Prisma.Decimal;
        totalSpent: Prisma.Decimal;
      }
    | null = null;

  if (params.discordUserId) {
    updatedMember = await tx.member.update({
      where: { discordUserId: params.discordUserId },
      data: {
        totalBalance: { increment: totalBalanceDelta },
        income: { increment: incomeDelta },
        recharge: { increment: rechargeDelta },
        totalSpent: { increment: totalSpentDelta },
      },
      select: {
        totalBalance: true,
        income: true,
        recharge: true,
        totalSpent: true,
      },
    });

    if (!totalBalanceDelta.isZero()) {
      await tx.pEIWAN
        .update({
          where: { discordUserId: params.discordUserId },
          data: { balance: updatedMember.totalBalance },
        })
        .catch(() => {});
    }
  }

  return {
    totalBalance: DEC(updatedMember?.totalBalance ?? updatedJinleeUser.totalBalance),
    income: DEC(updatedMember?.income ?? updatedJinleeUser.income),
    recharge: DEC(updatedMember?.recharge ?? updatedJinleeUser.recharge),
    totalSpent: DEC(updatedMember?.totalSpent ?? updatedJinleeUser.totalSpent),
    loyaltyPoints: DEC(updatedJinleeUser.loyaltyPoints),
  };
};

export const syncJinleeWalletFromMemberTx = async (
  client: PrismaClientOrTransaction,
  discordUserId: string,
) => {
  const member = await client.member.findUnique({
    where: { discordUserId },
    select: memberWalletSelect,
  });
  if (!member) return null;

  const identity = await ensureJinleeIdentityForDiscordTx(client, discordUserId);
  return client.jinleeUser.update({
    where: { jinleeId: identity.jinleeId },
    data: {
      ...(member.serverDisplayName ? { discordDisplayName: member.serverDisplayName } : {}),
      totalBalance: member.totalBalance,
      income: member.income,
      recharge: member.recharge,
      totalSpent: member.totalSpent,
    },
    select: {
      jinleeId: true,
      discordUserId: true,
      totalBalance: true,
      income: true,
      recharge: true,
      totalSpent: true,
      loyaltyPoints: true,
    },
  });
};
