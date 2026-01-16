import { Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function updateMemberServerDisplayName(
  client: DbClient,
  discordUserId: string,
  displayName?: string | null
) {
  const name = displayName?.trim();
  if (!discordUserId || !name) return;
  try {
    await client.member.upsert({
      where: { discordUserId },
      create: { discordUserId, serverDisplayName: name },
      update: { serverDisplayName: name },
    });
    await client.pEIWAN.updateMany({
      where: { discordUserId },
      data: { serverDisplayName: name },
    });
  } catch (err) {
    console.error('[member] update server display name failed', err);
  }
}
