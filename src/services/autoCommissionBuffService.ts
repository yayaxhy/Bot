import { Prisma, PrismaClient } from '@prisma/client';
import { AttachmentBuilder, EmbedBuilder, type Client } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import prisma from '../db/prisma.js';

type TxLike = PrismaClient | Prisma.TransactionClient;

export const AUTO_COMMISSION_TARGET_SHARE = new Prisma.Decimal(0.91);
export const AUTO_COMMISSION_THRESHOLD = new Prisma.Decimal(12000);
export const AUTO_COMMISSION_WINDOW_DAYS = 30;
export const AUTO_COMMISSION_ACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_COMMISSION_WATCH_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_COMMISSION_WATCH_BATCH = 100;
const AUTO_COMMISSION_REMINDER_DAYS = 7;
const AUTO_COMMISSION_ROLE_ID = process.env.AUTO_COMMISSION_ROLE_ID ?? '1480003788877336736';
const AUTO_COMMISSION_ROLE_GUILD_ID =
  process.env.AUTO_COMMISSION_ROLE_GUILD_ID ?? process.env.SPENT_ROLE_GUILD_ID ?? '';
const LUCKY_STAR_FEED_CHANNEL_ID = process.env.LUCKY_STAR_FEED_CHANNEL_ID ?? '1480053526284734485';
const LUCKY_STAR_EMOJI = '<:chatVoucherEmoji:1469588578655797289>';
const CONGRATS_EMOJI = '<:congrats:1422362458596835480>';
const LUCKY_STAR_LOGO_PATH = path.resolve(process.cwd(), 'src', 'img', 'jinleelogo.jpg');
let autoCommissionWatcherRunning = false;
const luckyStarReminderSentForActiveUntil = new Map<string, string>();

const AUTO_COMMISSION_POSITIVE_TYPES = ['点单', '打赏', '红包收入'] as const;
const AUTO_COMMISSION_REVERT_TYPES = ['订单撤销', '打赏撤销'] as const;
const AUTO_COMMISSION_INCOME_TYPES = [
  ...AUTO_COMMISSION_POSITIVE_TYPES,
  ...AUTO_COMMISSION_REVERT_TYPES,
] as const;
const AUTO_COMMISSION_POSITIVE_TYPE_SET = new Set<string>(AUTO_COMMISSION_POSITIVE_TYPES);
const AUTO_COMMISSION_REVERT_TYPE_SET = new Set<string>(AUTO_COMMISSION_REVERT_TYPES);

const toDecimal = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

const getThresholdBucket = (amount: Prisma.Decimal) => {
  const numeric = amount.div(AUTO_COMMISSION_THRESHOLD).toNumber();
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
};

const parseTierExpiries = (value: Prisma.JsonValue | null | undefined) => {
  const map = new Map<number, Date>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return map;

  for (const [tierRaw, expiryRaw] of Object.entries(value as Record<string, unknown>)) {
    const tier = Number.parseInt(tierRaw, 10);
    if (!Number.isInteger(tier) || tier < 1) continue;
    if (typeof expiryRaw !== 'string') continue;
    const expiry = new Date(expiryRaw);
    if (Number.isNaN(expiry.getTime())) continue;
    map.set(tier, expiry);
  }
  return map;
};

const serializeTierExpiries = (map: Map<number, Date>): Prisma.InputJsonObject => {
  const obj: Record<string, string> = {};
  for (const [tier, expiry] of Array.from(map.entries()).sort((a, b) => a[0] - b[0])) {
    obj[String(tier)] = expiry.toISOString();
  }
  return obj;
};

const resolveTierActiveUntil = (map: Map<number, Date>, tier: number, now: Date) => {
  if (tier < 1) return null;
  const expiry = map.get(tier);
  if (!expiry || expiry <= now) return null;
  return expiry;
};

const formatDecimalAmount = (value: Prisma.Decimal) =>
  Number(value.toString()).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

const formatSharePercent = (share: Prisma.Decimal) => {
  const num = Number(share.mul(100).toString());
  if (!Number.isFinite(num)) return '0%';
  return `${num.toFixed(2).replace(/\.?0+$/, '')}%`;
};

const formatDateYmd = (value: Date) => value.toISOString().slice(0, 10);

async function postLuckyStarFeed(
  options:
    | { content: string }
    | { content?: string; embed: EmbedBuilder; withLogo?: boolean },
) {
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client || !LUCKY_STAR_FEED_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(LUCKY_STAR_FEED_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const send = (channel as any).send?.bind(channel);
    if (typeof send !== 'function') return;

    if ('content' in options && !('embed' in options)) {
      await send({ content: options.content });
      return;
    }

    if ('embed' in options) {
      if (options.withLogo && fs.existsSync(LUCKY_STAR_LOGO_PATH)) {
        const logo = new AttachmentBuilder(LUCKY_STAR_LOGO_PATH, { name: 'jinleelogo.jpg' });
        const embed = EmbedBuilder.from(options.embed).setThumbnail('attachment://jinleelogo.jpg');
        await send({ content: options.content, embeds: [embed], files: [logo] });
      } else {
        await send({ content: options.content, embeds: [options.embed] });
      }
    }
  } catch (err) {
    console.error('[auto-commission] lucky-star feed send failed', { err });
  }
}

async function syncAutoCommissionRole(userId: string, shouldHaveRole: boolean) {
  if (!AUTO_COMMISSION_ROLE_ID || !AUTO_COMMISSION_ROLE_GUILD_ID) return;

  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) return;

  try {
    const guild = await client.guilds.fetch(AUTO_COMMISSION_ROLE_GUILD_ID);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const hasRole = member.roles.cache.has(AUTO_COMMISSION_ROLE_ID);
    if (shouldHaveRole && !hasRole) {
      await member.roles.add(AUTO_COMMISSION_ROLE_ID);
    } else if (!shouldHaveRole && hasRole) {
      await member.roles.remove(AUTO_COMMISSION_ROLE_ID);
    }
  } catch (err) {
    console.error('[auto-commission] sync lucky-star role failed', { userId, err });
  }
}

async function notifyLuckyStarPromotion(userId: string) {
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) return;
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    const embed = new EmbedBuilder()
      .setColor(0xf7c948)
      .setDescription(
        [
          `${LUCKY_STAR_EMOJI} 恭喜你 ${CONGRATS_EMOJI}`,
          '累计30天收入达到12 000，晋升为锦鲤福星陪玩！',
          `抽成已自动调整为9%持续30天 ${LUCKY_STAR_EMOJI}`,
          '可在个人主页查看更多详情',
        ].join('\n'),
      );
    await user.send({ embeds: [embed] });
  } catch (err) {
    console.error('[auto-commission] lucky-star DM failed', { userId, err });
  }
}

async function notifyLuckyStarExpiryReminder(params: {
  userId: string;
  activeUntil: Date;
  baseShare: Prisma.Decimal;
  remainingAmount: Prisma.Decimal;
}) {
  const { userId, activeUntil, baseShare, remainingAmount } = params;
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) return;

  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;

    const endDate = activeUntil.toISOString().slice(0, 10);
    const baseLabel = formatSharePercent(baseShare);
    const needAmount = formatDecimalAmount(remainingAmount);

    const embed = new EmbedBuilder()
      .setColor(0xf7c948)
      .setTitle('锦鲤福星陪玩提醒')
      .setDescription(
        [
          `您的锦鲤福星陪玩福利结束时间为：${endDate}，获得比例将由 91% 自动调整为 ${baseLabel}。`,
          `您还需要完成${needAmount}元流水，才能继续享受锦鲤福星陪玩福利`,
        ].join('\n'),
      );

    const hasLogo = fs.existsSync(LUCKY_STAR_LOGO_PATH);
    if (hasLogo) {
      const logo = new AttachmentBuilder(LUCKY_STAR_LOGO_PATH, { name: 'jinleelogo.jpg' });
      embed.setThumbnail('attachment://jinleelogo.jpg');
      await user.send({ embeds: [embed], files: [logo] });
    } else {
      await user.send({ embeds: [embed] });
    }

    await postLuckyStarFeed({
      content: `<@${userId}>`,
      embed,
      withLogo: true,
    });
  } catch (err) {
    console.error('[auto-commission] lucky-star reminder DM failed', { userId, err });
  }
}

export function getAutoCommissionWindow(now = new Date()) {
  const utcStartOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const windowStart = new Date(utcStartOfToday.getTime() - (AUTO_COMMISSION_WINDOW_DAYS - 1) * DAY_MS);
  return { windowStart, windowEnd: now };
}

export async function computeAutoCommissionIncome(
  tx: TxLike,
  discordUserId: string,
  now = new Date(),
) {
  const { windowStart, windowEnd } = getAutoCommissionWindow(now);
  const rows = await tx.individualTransaction.findMany({
    where: {
      discordId: discordUserId,
      timeCreatedAt: { gte: windowStart, lte: windowEnd },
      typeOfTransaction: { in: [...AUTO_COMMISSION_INCOME_TYPES] },
    },
    select: {
      typeOfTransaction: true,
      balanceBefore: true,
      balanceAfter: true,
    },
  });

  const amount = rows.reduce((sum, row) => {
    const before = toDecimal(row.balanceBefore ?? 0);
    const after = toDecimal(row.balanceAfter ?? 0);
    const delta = after.sub(before);
    if (AUTO_COMMISSION_POSITIVE_TYPE_SET.has(row.typeOfTransaction)) {
      return delta.gt(0) ? sum.add(delta) : sum;
    }
    if (AUTO_COMMISSION_REVERT_TYPE_SET.has(row.typeOfTransaction)) {
      return delta.lt(0) ? sum.add(delta) : sum;
    }
    return sum;
  }, new Prisma.Decimal(0));

  return { amount, windowStart, windowEnd };
}

export async function evaluateAutoCommissionBuff(userId: string, now = new Date()) {
  return evaluateAutoCommissionBuffWithReason(userId, 'income', now);
}

export async function evaluateAutoCommissionBuffWithReason(
  userId: string,
  reason: 'income' | 'revert' | 'manual',
  now = new Date(),
) {
  const result = await prisma.$transaction(async (tx) => {
    const peiwan = await tx.pEIWAN.findUnique({
      where: { discordUserId: userId },
      select: {
        discordUserId: true,
        commissionRate: true,
        baseCommissionRate: true,
      },
    });
    if (!peiwan) {
      await tx.autoCommissionBuff.deleteMany({ where: { userId } });
      const { windowStart, windowEnd } = getAutoCommissionWindow(now);
      return {
        userId,
        amount: new Prisma.Decimal(0),
        threshold: AUTO_COMMISSION_THRESHOLD,
        windowStart,
        windowEnd,
        activeUntil: null as Date | null,
        qualified: false,
        roleActive: false,
        roleChanged: false,
        promotedNow: false,
      };
    }
    const member = await tx.member.findUnique({
      where: { discordUserId: userId },
      select: {
        commissionRate: true,
        baseCommissionRate: true,
      },
    });

    const existing = await tx.autoCommissionBuff.findUnique({
      where: { userId },
      select: { activeUntil: true, lastQualifiedAt: true, currentAmount: true, tierExpiries: true },
    });
    const previousActiveUntil = existing?.activeUntil ?? null;
    const previousRoleActive = !!(existing?.activeUntil && existing.activeUntil > now);
    const { amount, windowStart, windowEnd } = await computeAutoCommissionIncome(tx, userId, now);
    const qualified = amount.gte(AUTO_COMMISSION_THRESHOLD);
    const previousBucket = getThresholdBucket(toDecimal(existing?.currentAmount ?? 0));
    const currentBucket = getThresholdBucket(amount);
    const tierExpiries = parseTierExpiries(existing?.tierExpiries);

    if (
      currentBucket >= 1 &&
      !tierExpiries.has(currentBucket) &&
      existing?.activeUntil &&
      existing.activeUntil > now
    ) {
      // 兼容旧数据：上线前只有一个 activeUntil，没有分档位到期时间
      tierExpiries.set(currentBucket, existing.activeUntil);
    }

    let activeUntil: Date | null = null;
    let lastQualifiedAt: Date | null = existing?.lastQualifiedAt ?? null;

    if (currentBucket > previousBucket && currentBucket >= 1) {
      const refreshedUntil = new Date(now.getTime() + AUTO_COMMISSION_ACTIVE_DAYS * DAY_MS);
      for (let tier = previousBucket + 1; tier <= currentBucket; tier += 1) {
        tierExpiries.set(tier, refreshedUntil);
      }
      activeUntil = refreshedUntil;
      lastQualifiedAt = now;
    } else if (currentBucket >= 1) {
      // 回退档位时，恢复到对应档位原本的到期时间（不继承更高档位）
      activeUntil = resolveTierActiveUntil(tierExpiries, currentBucket, now);
    } else if (reason === 'revert') {
      // 撤销导致跌破 1 档，立即失效
      activeUntil = null;
    } else {
      // 非撤销场景下，保留当前有效期直到自然到期
      activeUntil =
        existing?.activeUntil && existing.activeUntil > now ? existing.activeUntil : null;
    }

    // Keep a baseline share for restoring after auto-9% ends.
    const storedBase =
      peiwan.baseCommissionRate ??
      member?.baseCommissionRate ??
      peiwan.commissionRate ??
      member?.commissionRate ??
      new Prisma.Decimal(0.75);
    const currentShare = toDecimal(peiwan.commissionRate ?? member?.commissionRate ?? storedBase);
    const resolvedBase = toDecimal(storedBase);
    const desiredShare = activeUntil ? AUTO_COMMISSION_TARGET_SHARE : resolvedBase;
    const nextTarget = AUTO_COMMISSION_THRESHOLD.mul(currentBucket + 1);
    const remainingToNextRaw = nextTarget.sub(amount);
    const remainingToNext = remainingToNextRaw.gt(0)
      ? remainingToNextRaw
      : new Prisma.Decimal(0);
    const reminderWindowStart = activeUntil
      ? new Date(activeUntil.getTime() - AUTO_COMMISSION_REMINDER_DAYS * DAY_MS)
      : null;
    const reminderNeeded = !!(
      activeUntil &&
      activeUntil > now &&
      reminderWindowStart &&
      now >= reminderWindowStart &&
      remainingToNext.gt(0)
    );

    await tx.autoCommissionBuff.upsert({
      where: { userId },
      create: {
        userId,
        targetShare: AUTO_COMMISSION_TARGET_SHARE,
        thresholdAmount: AUTO_COMMISSION_THRESHOLD,
        windowDays: AUTO_COMMISSION_WINDOW_DAYS,
        windowStart,
        windowEnd,
        currentAmount: amount,
        tierExpiries: serializeTierExpiries(tierExpiries),
        activeUntil: activeUntil ?? undefined,
        lastQualifiedAt: lastQualifiedAt ?? undefined,
      },
      update: {
        targetShare: AUTO_COMMISSION_TARGET_SHARE,
        thresholdAmount: AUTO_COMMISSION_THRESHOLD,
        windowDays: AUTO_COMMISSION_WINDOW_DAYS,
        windowStart,
        windowEnd,
        currentAmount: amount,
        tierExpiries: serializeTierExpiries(tierExpiries),
        activeUntil,
        lastQualifiedAt,
      },
    });

    const peiwanBaseNow = toDecimal(peiwan.baseCommissionRate ?? resolvedBase);
    if (!peiwanBaseNow.eq(resolvedBase) || !currentShare.eq(desiredShare)) {
      await tx.pEIWAN.update({
        where: { discordUserId: userId },
        data: {
          baseCommissionRate: resolvedBase,
          commissionRate: desiredShare,
        },
      });
    }
    if (member) {
      const memberShareNow = toDecimal(member.commissionRate ?? currentShare);
      const memberBaseNow = toDecimal(member.baseCommissionRate ?? resolvedBase);
      if (!memberBaseNow.eq(resolvedBase) || !memberShareNow.eq(desiredShare)) {
        await tx.member.update({
          where: { discordUserId: userId },
          data: {
            baseCommissionRate: resolvedBase,
            commissionRate: desiredShare,
          },
        });
      }
    }

    return {
      userId,
      amount,
      threshold: AUTO_COMMISSION_THRESHOLD,
      windowStart,
      windowEnd,
      activeUntil,
      qualified,
      roleActive: !!(activeUntil && activeUntil > now),
      roleChanged: previousRoleActive !== !!(activeUntil && activeUntil > now),
      promotedNow: !previousRoleActive && !!(activeUntil && activeUntil > now),
      refreshedNow: !!(
        previousRoleActive &&
        previousActiveUntil &&
        activeUntil &&
        activeUntil.getTime() > previousActiveUntil.getTime()
      ),
      previousActiveUntil,
      reminderNeeded,
      remainingToNext,
      baseShare: resolvedBase,
    };
  });

  if (reason === 'manual' || result.roleChanged) {
    await syncAutoCommissionRole(userId, result.roleActive);
  }
  if (result.promotedNow) {
    const baseShare = result.baseShare ?? new Prisma.Decimal(0.75);
    await notifyLuckyStarPromotion(userId);
    await postLuckyStarFeed({
      content: `<@${userId}>陪玩已晋升至锦鲤福星陪玩，抽成由${formatSharePercent(
        baseShare,
      )}自动调整为91%，结束时间为：${formatDateYmd(result.activeUntil!)}`,
    });
  } else if (result.refreshedNow && result.activeUntil && result.previousActiveUntil) {
    await postLuckyStarFeed({
      content: `<@${userId}>陪玩已满足锦鲤福星陪玩的晋升要求，抽成保持91%，原结束时间为：${formatDateYmd(
        result.previousActiveUntil,
      )}，新结束时间为：${formatDateYmd(result.activeUntil)}`,
    });
  }
  const activeUntilKey = result.activeUntil?.toISOString() ?? '';
  if (!result.activeUntil) {
    luckyStarReminderSentForActiveUntil.delete(userId);
  } else if (result.reminderNeeded && luckyStarReminderSentForActiveUntil.get(userId) !== activeUntilKey) {
    luckyStarReminderSentForActiveUntil.set(userId, activeUntilKey);
    await notifyLuckyStarExpiryReminder({
      userId,
      activeUntil: result.activeUntil,
      baseShare: result.baseShare,
      remainingAmount: result.remainingToNext,
    });
  }

  return result;
}

export async function refreshAllAutoCommissionBuffs(now = new Date()) {
  const peiwanRows = await prisma.pEIWAN.findMany({
    select: { discordUserId: true },
  });
  for (const row of peiwanRows) {
    try {
      await evaluateAutoCommissionBuffWithReason(row.discordUserId, 'manual', now);
    } catch (err) {
      console.error('[auto-commission] refresh one user failed', { userId: row.discordUserId, err });
    }
  }
}

async function refreshExpiredAutoCommissionBuffs(batchSize: number): Promise<number> {
  const now = new Date();
  const rows = await prisma.autoCommissionBuff.findMany({
    where: {
      activeUntil: { lte: now },
    },
    select: { userId: true },
    orderBy: { activeUntil: 'asc' },
    take: batchSize,
  });
  if (!rows.length) return 0;

  for (const row of rows) {
    try {
      await evaluateAutoCommissionBuffWithReason(row.userId, 'manual', now);
    } catch (err) {
      console.error('[auto-commission] refresh expired user failed', { userId: row.userId, err });
    }
  }
  return rows.length;
}

export function startAutoCommissionBuffWatcher() {
  const run = async () => {
    if (autoCommissionWatcherRunning) return;
    autoCommissionWatcherRunning = true;
    try {
      while (true) {
        const processed = await refreshExpiredAutoCommissionBuffs(AUTO_COMMISSION_WATCH_BATCH);
        if (processed === 0) break;
      }
    } catch (err) {
      console.error('[auto-commission] watcher failed', err);
    } finally {
      autoCommissionWatcherRunning = false;
    }
  };

  run().catch(() => {});
  setInterval(run, AUTO_COMMISSION_WATCH_INTERVAL_MS);
}

export async function getAutoCommissionBoost(
  tx: TxLike,
  userId: string,
  baseShare: Prisma.Decimal,
): Promise<Prisma.Decimal> {
  const row = await tx.autoCommissionBuff.findUnique({
    where: { userId },
    select: {
      targetShare: true,
      activeUntil: true,
    },
  });
  if (!row?.activeUntil || row.activeUntil <= new Date()) return new Prisma.Decimal(0);

  const targetShare = toDecimal(row.targetShare ?? AUTO_COMMISSION_TARGET_SHARE);
  const boost = targetShare.sub(baseShare);
  return boost.gt(0) ? boost : new Prisma.Decimal(0);
}
