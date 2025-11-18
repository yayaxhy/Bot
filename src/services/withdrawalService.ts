import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import {
  CUSTOMER_SERVICE_DISCORD_ID,
  recordIndividualTransaction,
} from './individualTransactionService.js';

export interface WithdrawalParams {
  userDiscordId: string;
  amount: number | string;
  operatorDiscordId?: string;
  note?: string;
}

export interface WithdrawalResult {
  transactionId: string;
  userDiscordId: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  incomeBefore: string;
  incomeAfter: string;
}

const asDecimal = (value: number | string) => new Prisma.Decimal(value);

export async function processWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult> {
  const amountDecimal = asDecimal(params.amount);

  if (amountDecimal.lte(0)) {
    throw new Error('提现金额必须大于 0');
  }

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: { discordUserId: params.userDiscordId },
      select: { discordUserId: true, totalBalance: true, income: true },
    });

    if (!member) {
      throw new Error('未找到该成员');
    }

    const balanceBefore = new Prisma.Decimal(member.totalBalance ?? 0);
    const incomeBefore = new Prisma.Decimal(member.income ?? 0);

    if (balanceBefore.lt(amountDecimal) || incomeBefore.lt(amountDecimal)) {
      throw new Error('余额不足，无法提现');
    }

    const balanceAfter = balanceBefore.sub(amountDecimal);
    const incomeAfter = incomeBefore.sub(amountDecimal);

    await tx.member.update({
      where: { discordUserId: params.userDiscordId },
      data: {
        totalBalance: { decrement: amountDecimal },
        income: { decrement: amountDecimal },
      },
    });

    const ledger = await recordIndividualTransaction(tx, {
      discordId: params.userDiscordId,
      thirdPartydiscordId: params.operatorDiscordId ?? CUSTOMER_SERVICE_DISCORD_ID,
      balanceBefore,
      amountChange: amountDecimal,
      balanceAfter,
      typeOfTransaction: '提现',
    });

    return {
      transactionId: ledger.transactionId,
      userDiscordId: params.userDiscordId,
      amount: amountDecimal.toFixed(2),
      balanceBefore: balanceBefore.toFixed(2),
      balanceAfter: balanceAfter.toFixed(2),
      incomeBefore: incomeBefore.toFixed(2),
      incomeAfter: incomeAfter.toFixed(2),
    };
  });
}
