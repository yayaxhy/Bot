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
    key: 'category',
    kind: 'lottery',
    label: '抽奖代金券',
    prizeName: PRIZE_NAMES.LOTTERY_VOUCHER,
    quantity: 1,
  },
];

export type GiftWallRewardGrant = {
  label: string;
  quantity: number;
  category: string;
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

    const giftInfo = await tx.gift.findUnique({
      where: { GiftName: giftName },
      select: { giftImage: { select: { category: true, fileName: true } } },
    });
    const category = giftInfo?.giftImage?.category?.trim() ?? '';
    const fileName = giftInfo?.giftImage?.fileName ?? '';
    if (!category || category === '老板' || !fileName) return null;

    const categoryGifts = await tx.gift.findMany({
      where: {
        active: true,
        giftImage: {
          is: {
            category,
            fileName: { not: '' },
          },
        },
      },
      select: { GiftName: true },
    });
    if (!categoryGifts.length) return null;

    const giftNames = categoryGifts.map((gift) => gift.GiftName);
    const unlockedCount = await tx.peiwanGiftUnlock.count({
      where: { discordUserId: receiverId, giftName: { in: giftNames } },
    });
    if (unlockedCount < giftNames.length) return null;

    for (const reward of GIFT_WALL_REWARDS) {
      if (!reward.quantity || reward.quantity <= 0) continue;
      const rewardKey = `${reward.key}:${category}`;

      const existingClaim = await tx.peiwanGiftRewardClaim.findUnique({
        where: {
          discordUserId_rewardKey: {
            discordUserId: receiverId,
            rewardKey,
          },
        },
      });
      if (existingClaim) continue;

      if (reward.kind === 'coupon') {
        if (!reward.couponType) continue;
        try {
          await tx.peiwanGiftRewardClaim.create({
            data: { discordUserId: receiverId, rewardKey },
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
            data: { discordUserId: receiverId, rewardKey },
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

      return { label: reward.label, quantity: reward.quantity, category };
    }

    return null;
  });
}
