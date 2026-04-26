import prisma from '../db/prisma.js';

export type BlacklistConflict = {
  blockerId: string;
  blockedId: string;
} | null;

export async function findBlacklistConflict(
  firstUserId: string,
  secondUserId: string,
): Promise<BlacklistConflict> {
  if (!firstUserId || !secondUserId || firstUserId === secondUserId) {
    return null;
  }

  return prisma.blacklist.findFirst({
    where: {
      OR: [
        { blockerId: firstUserId, blockedId: secondUserId },
        { blockerId: secondUserId, blockedId: firstUserId },
      ],
    },
    select: {
      blockerId: true,
      blockedId: true,
    },
  });
}
