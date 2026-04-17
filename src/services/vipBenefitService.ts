import crypto from 'node:crypto';
import {
  CouponStatus,
  LotteryStatus,
  Prisma,
  VipBenefitDeliveryKind,
  VipBenefitInstanceStatus,
  type VipBenefitGrant,
  type VipBenefitGrantInstance,
} from '@prisma/client';
import prisma from '../db/prisma.js';
import {
  getVipTierByLevel,
  listOneTimeAutoBenefitsForLevel,
  VIP_TIERS,
  type VipOneTimeAutoBenefit,
} from '../config/vipCatalog.js';
import { ensureJinleeIdentityForDiscordTx } from './jinleeAccountService.js';
import { adjustLoyaltyPointsTx } from './loyaltyPointService.js';
import { isUniqueConstraintError, realignCouponSequence } from './sequenceService.js';

const DEC = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

const BENEFIT_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

type ReconcileVipBenefitsOptions = {
  previousVipLevel: number;
  currentVipLevel: number;
  vipRoleSynced?: boolean;
};

type ReconcileSummary = {
  granted: string[];
  revoked: string[];
  current: string[];
  contact: string[];
};

type TxClient = Prisma.TransactionClient;

function buildCountMap(labels: string[]) {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

function formatCountMap(labels: string[]) {
  return [...buildCountMap(labels).entries()].map(([label, count]) => (count > 1 ? `${label} x${count}` : label));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function createCouponBenefitTx(
  tx: TxClient,
  discordUserId: string,
  benefit: Extract<VipOneTimeAutoBenefit, { kind: 'coupon' }>,
) {
  const identity = await ensureJinleeIdentityForDiscordTx(tx, discordUserId);
  const expiresAt = new Date(Date.now() + BENEFIT_EXPIRE_MS);

  while (true) {
    try {
      const coupon = await tx.coupon.create({
        data: {
          discordId: identity.discordUserId ?? discordUserId,
          jinleeId: identity.jinleeId,
          type: benefit.couponType,
          status: CouponStatus.ACTIVE,
          expiresAt,
        },
        select: { id: true },
      });
      return coupon.id;
    } catch (err) {
      if (isUniqueConstraintError(err, 'id')) {
        await realignCouponSequence(tx);
        continue;
      }
      throw err;
    }
  }
}

async function createLotteryBenefitTx(
  tx: TxClient,
  discordUserId: string,
  benefit: Extract<VipOneTimeAutoBenefit, { kind: 'lottery' }>,
  benefitCode: string,
  sequence: number,
) {
  const identity = await ensureJinleeIdentityForDiscordTx(tx, discordUserId);
  const prize = await tx.lotteryPrize.findFirst({
    where: { name: benefit.lotteryPrizeName },
    select: { id: true, pool: true },
  });
  if (!prize) {
    throw new Error(`vip_benefit_prize_not_found:${benefit.lotteryPrizeName}`);
  }

  const draw = await tx.lotteryDraw.create({
    data: {
      nonce: `vip:${benefitCode}:${sequence}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`,
      requestId: `vip-benefit:${benefitCode}:${sequence}`,
      userId: identity.discordUserId ?? discordUserId,
      jinleeId: identity.jinleeId,
      pool: prize.pool,
      prizeId: prize.id,
      cost: DEC(0),
      random: Math.random(),
      status: LotteryStatus.UNUSED,
      expiresAt: new Date(Date.now() + BENEFIT_EXPIRE_MS),
      code: `VIP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    },
    select: { id: true },
  });

  return draw.id;
}

async function createBenefitInstanceTx(
  tx: TxClient,
  grant: VipBenefitGrant,
  discordUserId: string,
  benefit: VipOneTimeAutoBenefit,
  sequence: number,
) {
  const now = new Date();
  if (benefit.kind === 'points') {
    await adjustLoyaltyPointsTx(tx, discordUserId, DEC(benefit.pointsAmount));
    await tx.vipBenefitGrantInstance.create({
      data: {
        grantId: grant.id,
        sequence,
        deliveryKind: VipBenefitDeliveryKind.POINTS,
        status: VipBenefitInstanceStatus.FINALIZED,
        pointsAmount: DEC(benefit.pointsAmount),
        grantedAt: now,
        finalizedAt: now,
      },
    });
    return;
  }

  if (benefit.kind === 'coupon') {
    const couponId = await createCouponBenefitTx(tx, discordUserId, benefit);
    await tx.vipBenefitGrantInstance.create({
      data: {
        grantId: grant.id,
        sequence,
        deliveryKind: VipBenefitDeliveryKind.COUPON,
        status: VipBenefitInstanceStatus.ACTIVE,
        couponType: benefit.couponType,
        sourceCouponId: couponId,
        grantedAt: now,
      },
    });
    return;
  }

  const lotteryDrawId = await createLotteryBenefitTx(tx, discordUserId, benefit, benefit.code, sequence);
  await tx.vipBenefitGrantInstance.create({
    data: {
      grantId: grant.id,
      sequence,
      deliveryKind: VipBenefitDeliveryKind.LOTTERY,
      status: VipBenefitInstanceStatus.ACTIVE,
      lotteryPrizeName: benefit.lotteryPrizeName,
      sourceLotteryDrawId: lotteryDrawId,
      grantedAt: now,
    },
  });
}

async function reissueBenefitInstanceTx(
  tx: TxClient,
  instance: VipBenefitGrantInstance,
  discordUserId: string,
  benefit: Exclude<VipOneTimeAutoBenefit, { kind: 'points' }>,
) {
  const now = new Date();
  if (benefit.kind === 'coupon') {
    const couponId = await createCouponBenefitTx(tx, discordUserId, benefit);
    await tx.vipBenefitGrantInstance.update({
      where: { id: instance.id },
      data: {
        status: VipBenefitInstanceStatus.ACTIVE,
        couponType: benefit.couponType,
        sourceCouponId: couponId,
        sourceLotteryDrawId: null,
        grantedAt: now,
        revokedAt: null,
        finalizedAt: null,
      },
    });
    return;
  }

  const lotteryDrawId = await createLotteryBenefitTx(tx, discordUserId, benefit, benefit.code, instance.sequence);
  await tx.vipBenefitGrantInstance.update({
    where: { id: instance.id },
    data: {
      status: VipBenefitInstanceStatus.ACTIVE,
      lotteryPrizeName: benefit.lotteryPrizeName,
      sourceCouponId: null,
      sourceLotteryDrawId: lotteryDrawId,
      grantedAt: now,
      revokedAt: null,
      finalizedAt: null,
    },
  });
}

async function finalizeBenefitInstanceTx(tx: TxClient, instanceId: string, finalizedAt = new Date()) {
  await tx.vipBenefitGrantInstance.update({
    where: { id: instanceId },
    data: {
      status: VipBenefitInstanceStatus.FINALIZED,
      finalizedAt,
    },
  });
}

async function revokeActiveCouponInstanceTx(tx: TxClient, instance: VipBenefitGrantInstance, now: Date) {
  const couponId = instance.sourceCouponId;
  if (!couponId) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }

  const coupon = await tx.coupon.findUnique({
    where: { id: couponId },
    select: { status: true, expiresAt: true },
  });
  if (!coupon) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }
  if (coupon.status === CouponStatus.USED) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }
  if (coupon.status === CouponStatus.EXPIRED || coupon.expiresAt <= now) {
    if (coupon.status === CouponStatus.ACTIVE) {
      await tx.coupon.update({
        where: { id: couponId },
        data: { status: CouponStatus.EXPIRED },
      });
    }
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }

  const updated = await tx.coupon.updateMany({
    where: { id: couponId, status: CouponStatus.ACTIVE, expiresAt: { gt: now } },
    data: { status: CouponStatus.EXPIRED },
  });
  if (updated.count <= 0) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }

  await tx.vipBenefitGrantInstance.update({
    where: { id: instance.id },
    data: {
      status: VipBenefitInstanceStatus.REVOKED,
      revokedAt: now,
    },
  });
  return true;
}

async function revokeActiveLotteryInstanceTx(tx: TxClient, instance: VipBenefitGrantInstance, now: Date) {
  const lotteryDrawId = instance.sourceLotteryDrawId;
  if (!lotteryDrawId) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }

  const draw = await tx.lotteryDraw.findUnique({
    where: { id: lotteryDrawId },
    select: { status: true, expiresAt: true },
  });
  if (!draw) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }
  if (draw.status === LotteryStatus.USED) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }
  if (draw.status === LotteryStatus.EXPIRED || (draw.expiresAt != null && draw.expiresAt <= now)) {
    if (draw.status === LotteryStatus.UNUSED) {
      await tx.lotteryDraw.update({
        where: { id: lotteryDrawId },
        data: { status: LotteryStatus.EXPIRED, expiresAt: now },
      });
    }
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }

  const updated = await tx.lotteryDraw.updateMany({
    where: { id: lotteryDrawId, status: LotteryStatus.UNUSED },
    data: { status: LotteryStatus.EXPIRED, expiresAt: now },
  });
  if (updated.count <= 0) {
    await finalizeBenefitInstanceTx(tx, instance.id, now);
    return false;
  }

  await tx.vipBenefitGrantInstance.update({
    where: { id: instance.id },
    data: {
      status: VipBenefitInstanceStatus.REVOKED,
      revokedAt: now,
    },
  });
  return true;
}

async function finalizeInactiveInstanceIfNeeded(tx: TxClient, instance: VipBenefitGrantInstance, now: Date) {
  if (instance.status !== VipBenefitInstanceStatus.ACTIVE) {
    return false;
  }

  if (instance.deliveryKind === VipBenefitDeliveryKind.COUPON) {
    const couponId = instance.sourceCouponId;
    if (!couponId) {
      await finalizeBenefitInstanceTx(tx, instance.id, now);
      return true;
    }
    const coupon = await tx.coupon.findUnique({
      where: { id: couponId },
      select: { status: true, expiresAt: true },
    });
    if (!coupon) {
      await finalizeBenefitInstanceTx(tx, instance.id, now);
      return true;
    }
    if (coupon.status === CouponStatus.USED || coupon.status === CouponStatus.EXPIRED || coupon.expiresAt <= now) {
      if (coupon.status === CouponStatus.ACTIVE && coupon.expiresAt <= now) {
        await tx.coupon.update({ where: { id: couponId }, data: { status: CouponStatus.EXPIRED } });
      }
      await finalizeBenefitInstanceTx(tx, instance.id, now);
      return true;
    }
    return false;
  }

  if (instance.deliveryKind === VipBenefitDeliveryKind.LOTTERY) {
    const lotteryDrawId = instance.sourceLotteryDrawId;
    if (!lotteryDrawId) {
      await finalizeBenefitInstanceTx(tx, instance.id, now);
      return true;
    }
    const draw = await tx.lotteryDraw.findUnique({
      where: { id: lotteryDrawId },
      select: { status: true, expiresAt: true },
    });
    if (!draw) {
      await finalizeBenefitInstanceTx(tx, instance.id, now);
      return true;
    }
    if (draw.status === LotteryStatus.USED || draw.status === LotteryStatus.EXPIRED || (draw.expiresAt != null && draw.expiresAt <= now)) {
      if (draw.status === LotteryStatus.UNUSED && draw.expiresAt != null && draw.expiresAt <= now) {
        await tx.lotteryDraw.update({
          where: { id: lotteryDrawId },
          data: { status: LotteryStatus.EXPIRED, expiresAt: now },
        });
      }
      await finalizeBenefitInstanceTx(tx, instance.id, now);
      return true;
    }
  }

  return false;
}

async function ensureBenefitGrantTx(
  tx: TxClient,
  discordUserId: string,
  benefit: VipOneTimeAutoBenefit,
  vipLevel: number,
  grantedLabels: string[],
) {
  const grant = await tx.vipBenefitGrant.upsert({
    where: {
      discordUserId_benefitCode: {
        discordUserId,
        benefitCode: benefit.code,
      },
    },
    update: {
      vipLevel,
      benefitLabel: benefit.label,
    },
    create: {
      discordUserId,
      vipLevel,
      benefitCode: benefit.code,
      benefitLabel: benefit.label,
    },
  });

  const instances = await tx.vipBenefitGrantInstance.findMany({
    where: { grantId: grant.id },
    orderBy: { sequence: 'asc' },
  });
  const bySequence = new Map(instances.map((instance) => [instance.sequence, instance] as const));
  const now = new Date();

  for (let sequence = 1; sequence <= benefit.quantity; sequence += 1) {
    const instance = bySequence.get(sequence);
    if (!instance) {
      await createBenefitInstanceTx(tx, grant, discordUserId, benefit, sequence);
      grantedLabels.push(benefit.label);
      continue;
    }

    if (instance.status === VipBenefitInstanceStatus.REVOKED) {
      if (benefit.kind !== 'points') {
        await reissueBenefitInstanceTx(tx, instance, discordUserId, benefit);
        grantedLabels.push(benefit.label);
      }
      continue;
    }

    if (instance.status === VipBenefitInstanceStatus.ACTIVE) {
      await finalizeInactiveInstanceIfNeeded(tx, instance, now);
    }
  }
}

async function revokeBenefitGrantTx(
  tx: TxClient,
  benefit: Extract<VipOneTimeAutoBenefit, { revocable: true }>,
  discordUserId: string,
  revokedLabels: string[],
) {
  const grant = await tx.vipBenefitGrant.findUnique({
    where: {
      discordUserId_benefitCode: {
        discordUserId,
        benefitCode: benefit.code,
      },
    },
    select: { id: true },
  });
  if (!grant) {
    return;
  }

  const activeInstances = await tx.vipBenefitGrantInstance.findMany({
    where: {
      grantId: grant.id,
      status: VipBenefitInstanceStatus.ACTIVE,
    },
  });
  if (!activeInstances.length) {
    return;
  }

  const now = new Date();
  for (const instance of activeInstances) {
    let revoked = false;
    if (instance.deliveryKind === VipBenefitDeliveryKind.COUPON) {
      revoked = await revokeActiveCouponInstanceTx(tx, instance, now);
    } else if (instance.deliveryKind === VipBenefitDeliveryKind.LOTTERY) {
      revoked = await revokeActiveLotteryInstanceTx(tx, instance, now);
    } else {
      await finalizeBenefitInstanceTx(tx, instance.id, now);
    }
    if (revoked) {
      revokedLabels.push(benefit.label);
    }
  }
}

function buildCurrentBenefitLines(previousVipLevel: number, currentVipLevel: number, vipRoleSynced: boolean) {
  const currentTier = getVipTierByLevel(currentVipLevel);
  if (!currentTier) {
    return ['当前未达到 VIP 等级'];
  }

  const lines = [`当前 VIP 等级：VIP ${currentTier.vipLevel} · ${currentTier.name}`];
  if (vipRoleSynced) {
    lines.push(`${currentTier.tagLabel}已同步`);
  }
  if (currentTier.pointBonusRate > 0) {
    lines.push(`积分获取加成：+${Math.round(currentTier.pointBonusRate * 100)}%`);
  }

  if (previousVipLevel > currentVipLevel && currentVipLevel > 0) {
    lines.push(`等级权益已调整为 VIP ${currentTier.vipLevel}`);
  }

  return lines;
}

async function sendVipBenefitSummaryDm(discordUserId: string, summary: ReconcileSummary) {
  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) {
    return;
  }

  const sections: string[] = ['您的 VIP 福利状态已更新：'];

  if (summary.current.length > 0) {
    sections.push(['当前已生效：', ...summary.current.map((line) => `- ${line}`)].join('\n'));
  }
  if (summary.granted.length > 0) {
    sections.push(['已自动发放：', ...summary.granted.map((line) => `- ${line}`)].join('\n'));
  }
  if (summary.revoked.length > 0) {
    sections.push(['已自动撤回：', ...summary.revoked.map((line) => `- ${line}`)].join('\n'));
  }
  if (summary.contact.length > 0) {
    sections.push(['请联系客服领取：', ...summary.contact.map((line) => `- ${line}`)].join('\n'));
  }

  try {
    const user = await client.users.fetch(discordUserId);
    await user.send(sections.join('\n\n'));
  } catch (err) {
    console.error('[vip-benefit] dm failed', { discordUserId, err });
  }
}

export async function reconcileVipBenefitsForMember(
  discordUserId: string,
  options: ReconcileVipBenefitsOptions,
) {
  const previousVipLevel = Math.max(0, options.previousVipLevel ?? 0);
  const currentVipLevel = Math.max(0, options.currentVipLevel ?? 0);
  const vipRoleSynced = options.vipRoleSynced ?? true;
  const grantedLabels: string[] = [];
  const revokedLabels: string[] = [];
  const firstNewVipLevel = Math.max(previousVipLevel + 1, 1);

  await prisma.$transaction(async (tx) => {
    for (let vipLevel = firstNewVipLevel; vipLevel <= currentVipLevel; vipLevel += 1) {
      for (const benefit of listOneTimeAutoBenefitsForLevel(vipLevel)) {
        await ensureBenefitGrantTx(tx, discordUserId, benefit, vipLevel, grantedLabels);
      }
    }

    for (let vipLevel = currentVipLevel + 1; vipLevel <= VIP_TIERS.length; vipLevel += 1) {
      for (const benefit of listOneTimeAutoBenefitsForLevel(vipLevel)) {
        if (!benefit.revocable) {
          continue;
        }
        await revokeBenefitGrantTx(tx, benefit, discordUserId, revokedLabels);
      }
    }

    await tx.vipBenefitProfile.upsert({
      where: { discordUserId },
      update: { lastSettledVipLevel: currentVipLevel },
      create: {
        discordUserId,
        lastSettledVipLevel: currentVipLevel,
      },
    });
  });

  const manualBenefits =
    previousVipLevel < currentVipLevel
      ? uniqueStrings(
          Array.from({ length: currentVipLevel - previousVipLevel }, (_, index) => previousVipLevel + index + 1)
            .flatMap((vipLevel) => getVipTierByLevel(vipLevel)?.manualBenefits ?? []),
        )
      : [];

  const current = buildCurrentBenefitLines(previousVipLevel, currentVipLevel, vipRoleSynced);
  const granted = formatCountMap(grantedLabels);
  const revoked = formatCountMap(revokedLabels);
  const shouldNotify =
    previousVipLevel !== currentVipLevel || granted.length > 0 || revoked.length > 0 || manualBenefits.length > 0;

  if (!shouldNotify) {
    return;
  }

  await sendVipBenefitSummaryDm(discordUserId, {
    current,
    granted,
    revoked,
    contact: manualBenefits,
  });
}
