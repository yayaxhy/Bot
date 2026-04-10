import { Prisma, PrismaClient } from '@prisma/client';
import { isUniqueConstraintError, realignIndividualTransactionSequence } from './sequenceService.js';
import { ensureJinleeIdentityForDiscordTx, syncJinleeWalletFromMemberTx } from './jinleeAccountService.js';

export const CUSTOMER_SERVICE_DISCORD_ID = '1421651539247894549';

type PrismaClientOrTransaction = Prisma.TransactionClient | PrismaClient;

const asDecimal = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

type RecordTransactionParams = {
  discordId?: string | null;
  jinleeId?: string | null;
  thirdPartydiscordId?: string;
  balanceBefore: Prisma.Decimal | number | string;
  amountChange: Prisma.Decimal | number | string;
  balanceAfter: Prisma.Decimal | number | string;
  typeOfTransaction: string;
  timeCreatedAt?: Date;
};

export async function recordIndividualTransaction(
  client: PrismaClientOrTransaction,
  params: RecordTransactionParams
) {
  let jinleeId = params.jinleeId ?? null;
  if (!jinleeId && params.discordId && params.discordId !== 'SYSTEM') {
    const identity = await ensureJinleeIdentityForDiscordTx(client, params.discordId);
    jinleeId = identity.jinleeId;
  }

  if (!params.discordId && !jinleeId) {
    throw new Error('discordId or jinleeId is required');
  }

  const balanceBefore = asDecimal(params.balanceBefore);
  const balanceAfter = asDecimal(params.balanceAfter);
  const amountChange = asDecimal(params.amountChange).abs();

  let thirdParty = params.thirdPartydiscordId;
  if (!thirdParty) {
    if (params.typeOfTransaction === '充值') {
      thirdParty = CUSTOMER_SERVICE_DISCORD_ID;
    } else {
      throw new Error('thirdPartydiscordId is required for non-recharge transactions');
    }
  }

  const createPayload = () =>
    client.individualTransaction.create({
      data: {
        discordId: params.discordId ?? null,
        jinleeId,
        thirdPartydiscordId: thirdParty,
        balanceBefore,
        amountChange,
        balanceAfter,
        typeOfTransaction: params.typeOfTransaction,
        timeCreatedAt: params.timeCreatedAt ?? new Date(),
      },
    });

  await realignIndividualTransactionSequence(client);

  try {
    const created = await createPayload();
    if (params.discordId && params.discordId !== 'SYSTEM') {
      await syncJinleeWalletFromMemberTx(client, params.discordId);
    }
    return created;
  } catch (err) {
    if (!isUniqueConstraintError(err, 'transactionId')) {
      throw err;
    }

    await realignIndividualTransactionSequence(client);

    const created = await createPayload();
    if (params.discordId && params.discordId !== 'SYSTEM') {
      await syncJinleeWalletFromMemberTx(client, params.discordId);
    }
    return created;
  }
}
