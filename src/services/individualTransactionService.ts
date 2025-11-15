import { Prisma, PrismaClient } from '@prisma/client';
import { isUniqueConstraintError, realignIndividualTransactionSequence } from './sequenceService.js';

export const CUSTOMER_SERVICE_DISCORD_ID = '1421651539247894549';

type PrismaClientOrTransaction = Prisma.TransactionClient | PrismaClient;

const asDecimal = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

type RecordTransactionParams = {
  discordId: string;
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

  const isPrismaClient = client instanceof PrismaClient;

  const createPayload = () =>
    client.individualTransaction.create({
      data: {
        discordId: params.discordId,
        thirdPartydiscordId: thirdParty,
        balanceBefore,
        amountChange,
        balanceAfter,
        typeOfTransaction: params.typeOfTransaction,
        timeCreatedAt: params.timeCreatedAt ?? new Date(),
      },
    });

  await realignIndividualTransactionSequence();

  try {
    return await createPayload();
  } catch (err) {
    if (!isUniqueConstraintError(err, 'transactionId')) {
      throw err;
    }

    await realignIndividualTransactionSequence();

    if (isPrismaClient) {
      return createPayload();
    }

    throw err;
  }
}
