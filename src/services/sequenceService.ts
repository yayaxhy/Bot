import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';

type SequenceRepairConfig = {
  sequenceName: string;
  tableName: string;
  columnName: string;
  substringFrom: number;
  pattern: string;
  minValue?: number;
};

async function realignPrefixedSequence(config: SequenceRepairConfig) {
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

  await prisma.$executeRawUnsafe(sql);
}

export async function realignIndividualTransactionSequence() {
  await realignPrefixedSequence({
    sequenceName: 'IndividualTransaction_transactionId_seq',
    tableName: 'IndividualTransaction',
    columnName: 'transactionId',
    substringFrom: 3,
    pattern: '^IT[0-9]+$',
  });
}

export async function realignRechargeSequence() {
  await realignPrefixedSequence({
    sequenceName: 'Recharge_RechargeID_seq',
    tableName: 'Recharge',
    columnName: 'RechargeID',
    substringFrom: 2,
    pattern: '^C[0-9]+$',
  });
}

export async function realignCouponSequence() {
  await realignPrefixedSequence({
    sequenceName: 'Coupon_id_seq',
    tableName: 'Coupon',
    columnName: 'id',
    substringFrom: 2,
    pattern: '^C[0-9]+$',
  });
}

export async function realignWithdrawSequence() {
  await realignPrefixedSequence({
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
