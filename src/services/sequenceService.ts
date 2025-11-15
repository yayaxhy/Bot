import { Prisma, PrismaClient } from '@prisma/client';

export type PrismaClientOrTransaction = PrismaClient | Prisma.TransactionClient;

type SequenceRepairConfig = {
  sequenceName: string;
  tableName: string;
  columnName: string;
  substringFrom: number;
  pattern: string;
  minValue?: number;
};

async function realignPrefixedSequence(
  client: PrismaClientOrTransaction,
  config: SequenceRepairConfig
) {
  const { sequenceName, tableName, columnName, substringFrom, pattern, minValue = 1 } = config;
  const sql = `
DO $$
DECLARE
  max_id BIGINT;
BEGIN
  SELECT MAX(substring("${columnName}" FROM ${substringFrom})::bigint)
  INTO max_id
  FROM "${tableName}"
  WHERE "${columnName}" ~ '${pattern}';

  IF max_id IS NULL OR max_id < ${minValue} THEN
    PERFORM setval('"${sequenceName}"', ${minValue}, false);
  ELSE
    PERFORM setval('"${sequenceName}"', max_id, true);
  END IF;
END $$;
`;

  await client.$executeRawUnsafe(sql);
}

export async function realignIndividualTransactionSequence(
  client: PrismaClientOrTransaction
) {
  await realignPrefixedSequence(client, {
    sequenceName: 'IndividualTransaction_transactionId_seq',
    tableName: 'IndividualTransaction',
    columnName: 'transactionId',
    substringFrom: 3,
    pattern: '^IT[0-9]+$',
  });
}

export async function realignRechargeSequence(client: PrismaClientOrTransaction) {
  await realignPrefixedSequence(client, {
    sequenceName: 'Recharge_RechargeID_seq',
    tableName: 'Recharge',
    columnName: 'RechargeID',
    substringFrom: 2,
    pattern: '^C[0-9]+$',
  });
}

export async function realignCouponSequence(client: PrismaClientOrTransaction) {
  await realignPrefixedSequence(client, {
    sequenceName: 'Coupon_id_seq',
    tableName: 'Coupon',
    columnName: 'id',
    substringFrom: 2,
    pattern: '^C[0-9]+$',
  });
}

export async function realignWithdrawSequence(client: PrismaClientOrTransaction) {
  await realignPrefixedSequence(client, {
    sequenceName: 'Withdraw_id_seq',
    tableName: 'Withdraw',
    columnName: 'id',
    substringFrom: 2,
    pattern: '^W[0-9]+$',
  });
}

export function isUniqueConstraintError(err: unknown, columnName: string) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray((err.meta as any)?.target) &&
    (err.meta as any).target.includes(columnName)
  );
}
