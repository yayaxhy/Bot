import prisma from '../db/prisma.js';

/** Add heart for payer→payee: amount￥ rounded to nearest int */
export async function addHeart(fromDiscordId: string, toDiscordId: string, amountYuan: number) {
  const inc = Math.round(amountYuan);
  if (inc <= 0) return;

  await prisma.heartCounter.upsert({
    where: { fromMemberId_toMemberId: { fromMemberId: fromDiscordId, toMemberId: toDiscordId } },
    create: { fromMemberId: fromDiscordId, toMemberId: toDiscordId, total: inc },
    update: { total: { increment: inc } },
  });
}
