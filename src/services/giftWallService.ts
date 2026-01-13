import { CouponStatus, CouponType, LotteryPool, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { isUniqueConstraintError, realignCouponSequence } from './sequenceService.js';
import { PRIZE_NAMES } from './lotteryService.js';

type RewardKind = 'coupon' | 'lottery';

type GiftWallReward = {
  key: string;
  kind: RewardKind;
  label: string;
  quantity: number;
  couponType?: CouponType;
  prizeName?: string;
};

const LOTTERY_REWARD_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;

const GIFT_WALL_REWARDS: GiftWallReward[] = [
  {
    key: 'all-gifts',
    kind: 'lottery',
    label: '抽奖代金券',
    prizeName: PRIZE_NAMES.LOTTERY_VOUCHER,
    quantity: 1,
  },
];

export type GiftWallRewardGrant = {
  label: string;
  quantity: number;
};

async function grantCouponReward(
  tx: Prisma.TransactionClient,
  receiverId: string,
  reward: GiftWallReward
) {
  if (!reward.couponType) return false;

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const data = Array.from({ length: reward.quantity }, () => ({
    discordId: receiverId,
    type: reward.couponType!,
    status: CouponStatus.ACTIVE,
    expiresAt,
  }));

  while (true) {
    try {
      await tx.coupon.createMany({ data });
      break;
    } catch (err) {
      if (isUniqueConstraintError(err, 'id')) {
        await realignCouponSequence(tx);
        continue;
      }
      throw err;
    }
  }
  return true;
}

async function grantLotteryReward(
  tx: Prisma.TransactionClient,
  receiverId: string,
  reward: GiftWallReward,
  prize: { id: string; pool: LotteryPool }
) {

  const now = Date.now();
  const expiresAt = new Date(now + LOTTERY_REWARD_EXPIRES_MS);
  const cost = new Prisma.Decimal(0);
  const data = Array.from({ length: reward.quantity }, (_, idx) => ({
    nonce: `giftwall:${reward.key}:${receiverId}:${now}:${idx}`,
    userId: receiverId,
    pool: prize.pool,
    prizeId: prize.id,
    cost,
    random: Math.random(),
    expiresAt,
  }));

  await tx.lotteryDraw.createMany({ data });
  return true;
}

export async function unlockGiftWallForPeiwan(params: {
  receiverId: string;
  giftName: string;
}): Promise<GiftWallRewardGrant | null> {
  const { receiverId, giftName } = params;
  if (!receiverId || !giftName) return null;
  if (!GIFT_WALL_REWARDS.length) return null;

  return prisma.$transaction(async (tx) => {
    const peiwan = await tx.pEIWAN.findUnique({
      where: { discordUserId: receiverId },
      select: { PEIWANID: true },
    });
    if (!peiwan) return null;

    await tx.peiwanGiftUnlock.createMany({
      data: [{ discordUserId: receiverId, giftName }],
      skipDuplicates: true,
    });

    const giftCatalog = await tx.gift.findMany({
      where: { active: true },
      select: { GiftName: true, giftImage: { select: { category: true } } },
    });
    const eligibleGiftNames = giftCatalog
      .filter((gift) => gift.giftImage?.category !== '老板')
      .map((gift) => gift.GiftName);
    if (eligibleGiftNames.length <= 0) return null;

    const unlockedCount = await tx.peiwanGiftUnlock.count({
      where: { discordUserId: receiverId, giftName: { in: eligibleGiftNames } },
    });
    if (unlockedCount < eligibleGiftNames.length) return null;

    for (const reward of GIFT_WALL_REWARDS) {
      if (!reward.quantity || reward.quantity <= 0) continue;

      const existingClaim = await tx.peiwanGiftRewardClaim.findUnique({
        where: {
          discordUserId_rewardKey: {
            discordUserId: receiverId,
            rewardKey: reward.key,
          },
        },
      });
      if (existingClaim) continue;

      if (reward.kind === 'coupon') {
        if (!reward.couponType) continue;
        try {
          await tx.peiwanGiftRewardClaim.create({
            data: { discordUserId: receiverId, rewardKey: reward.key },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            continue;
          }
          throw err;
        }

        await grantCouponReward(tx, receiverId, reward);
      } else if (reward.kind === 'lottery') {
        if (!reward.prizeName) continue;
        const prize = await tx.lotteryPrize.findFirst({
          where: { name: reward.prizeName },
          select: { id: true, pool: true },
        });
        if (!prize) continue;

        try {
          await tx.peiwanGiftRewardClaim.create({
            data: { discordUserId: receiverId, rewardKey: reward.key },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            continue;
          }
          throw err;
        }

        await grantLotteryReward(tx, receiverId, reward, prize);
      } else {
        continue;
      }

      return { label: reward.label, quantity: reward.quantity };
    }

    return null;
  });
}
