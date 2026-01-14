import { Prisma } from '@prisma/client';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

export async function adjustLoyaltyPointsTx(
  tx: Prisma.TransactionClient,
  discordUserId: string,
  delta: Prisma.Decimal
) {
  if (!discordUserId) return;
  const deltaValue = new Prisma.Decimal(delta);
  if (deltaValue.eq(0)) return;

  const existing = await tx.loyaltyPoint.findUnique({
    where: { discordUserId },
    select: { points: true },
  });

  if (!existing) {
    const initial = deltaValue.gt(0) ? deltaValue : DEC(0);
    await tx.loyaltyPoint.create({
      data: { discordUserId, points: initial },
    });
    return;
  }

  let next = new Prisma.Decimal(existing.points ?? 0).add(deltaValue);
  if (next.lt(0)) next = DEC(0);

  await tx.loyaltyPoint.update({
    where: { discordUserId },
    data: { points: next },
  });
}
