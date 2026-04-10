import { Prisma } from '@prisma/client';
import { ensureJinleeIdentityForDiscordTx, type JinleeIdentity } from './jinleeAccountService.js';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

export async function adjustLoyaltyPointsTx(
  tx: Prisma.TransactionClient,
  target: string | JinleeIdentity | null,
  delta: Prisma.Decimal
) {
  const deltaValue = new Prisma.Decimal(delta);
  if (deltaValue.eq(0)) return;
  if (!target) return;

  const identity =
    typeof target === 'string'
      ? await ensureJinleeIdentityForDiscordTx(tx, target)
      : target;

  const wallet = await tx.jinleeUser.findUnique({
    where: { jinleeId: identity.jinleeId },
    select: { loyaltyPoints: true },
  });
  if (!wallet) {
    throw new Error(`jinlee_user_not_found:${identity.jinleeId}`);
  }

  let next = new Prisma.Decimal(wallet.loyaltyPoints ?? 0).add(deltaValue);
  if (next.lt(0)) next = DEC(0);

  if (identity.discordUserId) {
    await tx.loyaltyPoint.upsert({
      where: { discordUserId: identity.discordUserId },
      update: { jinleeId: identity.jinleeId, points: next },
      create: {
        discordUserId: identity.discordUserId,
        jinleeId: identity.jinleeId,
        points: next,
      },
    });
  }

  await tx.jinleeUser.update({
    where: { jinleeId: identity.jinleeId },
    data: { loyaltyPoints: next },
  });
}
