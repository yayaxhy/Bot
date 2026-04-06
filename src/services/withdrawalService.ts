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
const WITHDRAW_LINK_TIMEOUT_MS = 10_000;
const WECHAT_WITHDRAW_ACCOUNT_FIELD = 'account1';
const ALLOWED_WECHAT_WITHDRAW_HOST = 'cdn.discordapp.com';

function normalizeWithdrawalMethod(note?: string | null): string {
  return note?.toString().trim().toLowerCase() ?? '';
}

function isWeChatWithdrawal(note?: string | null): boolean {
  const method = normalizeWithdrawalMethod(note);
  return method === '微信' || method === 'wechat' || method.includes('微信');
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isAllowedWeChatWithdrawalHost(url: URL): boolean {
  return url.hostname.toLowerCase() === ALLOWED_WECHAT_WITHDRAW_HOST;
}

async function assertValidWeChatWithdrawalImage(url: string) {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    throw new Error('微信提现收款码链接无效，请重新保存');
  }
  if (!isAllowedWeChatWithdrawalHost(parsed)) {
    throw new Error('微信提现收款码链接必须来自 cdn.discordapp.com，请重新保存');
  }

  let response: Response;
  try {
    response = await fetch(parsed, {
      method: 'GET',
      signal: AbortSignal.timeout(WITHDRAW_LINK_TIMEOUT_MS),
    });
  } catch {
    throw new Error('微信提现收款码链接无法访问，请重新保存');
  }

  try {
    if (!response.ok) {
      throw new Error('微信提现收款码链接无法访问，请重新保存');
    }

    const finalUrl = parseHttpUrl(response.url || parsed.toString());
    if (!finalUrl || !isAllowedWeChatWithdrawalHost(finalUrl)) {
      throw new Error('微信提现收款码链接必须来自 cdn.discordapp.com，请重新保存');
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('image/')) {
      throw new Error('微信提现收款码链接不是图片，请重新保存');
    }
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function ensureWeChatWithdrawalAccountReady(userDiscordId: string) {
  const account = await prisma.withdrawalAccount.findUnique({
    where: { discordUserId: userDiscordId },
    select: { account1: true },
  });

  const imageUrl = account?.[WECHAT_WITHDRAW_ACCOUNT_FIELD]?.trim();
  if (!imageUrl) {
    throw new Error('未设置微信提现收款码，请先保存后再提现');
  }

  await assertValidWeChatWithdrawalImage(imageUrl);
}

export async function processWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult> {
  const amountDecimal = asDecimal(params.amount);

  if (amountDecimal.lte(0)) {
    throw new Error('提现金额必须大于 0');
  }

  if (isWeChatWithdrawal(params.note)) {
    await ensureWeChatWithdrawalAccountReady(params.userDiscordId);
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
