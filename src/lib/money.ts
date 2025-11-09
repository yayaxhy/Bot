import { Prisma } from '@prisma/client';

export const D = (n: string | number) => new Prisma.Decimal(n);

/** HALF_UP to 2 decimals */
export function round2(x: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(x.toFixed(2, Prisma.Decimal.ROUND_HALF_UP));
}

/** ceil minutes between */
export function minutesBetweenCeil(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.ceil(ms / 60000));
}
