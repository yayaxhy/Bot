import { Prisma } from '@prisma/client';
import {
  PrismaClientOrTransaction,
  isUniqueConstraintError,
  realignIndividualTransactionSequence,
} from './sequenceService.js';

export const CUSTOMER_SERVICE_DISCORD_ID = '1421651539247894549';

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

  while (true) {
    try {
      return await client.individualTransaction.create({
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
    } catch (err) {
      if (isUniqueConstraintError(err, 'transactionId')) {
        await realignIndividualTransactionSequence(client);
        continue;
      }
      throw err;
    }
  }
}
