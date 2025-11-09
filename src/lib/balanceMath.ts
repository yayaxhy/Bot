import { Prisma } from '@prisma/client';

const toDecimal = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

export function splitIncomeRecharge(
  incomeValue: Prisma.Decimal | number | string,
  rechargeValue: Prisma.Decimal | number | string,
  amountValue: Prisma.Decimal | number | string
) {
  const income = toDecimal(incomeValue);
  const recharge = toDecimal(rechargeValue);
  const amount = toDecimal(amountValue);
  if (amount.lte(0)) throw new Error('金额必须大于 0。');

  const total = income.add(recharge);
  if (total.lt(amount)) {
    throw new Error('INSUFFICIENT_FUNDS');
  }

  const fromIncome = income.gte(amount) ? amount : income;
  const fromRecharge = amount.sub(fromIncome);

  return {
    fromIncome,
    fromRecharge,
    incomeAfter: income.sub(fromIncome),
    rechargeAfter: recharge.sub(fromRecharge),
    totalBefore: total,
    totalAfter: total.sub(amount),
  };
}
