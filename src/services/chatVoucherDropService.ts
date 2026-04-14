import crypto from 'node:crypto';
import { Client, EmbedBuilder, Events, Message } from 'discord.js';
import { CouponStatus, CouponType, LotteryPool, LotteryStatus, PrismaClient } from '@prisma/client';
import { ensureJinleeIdentityForDiscordTx } from './jinleeAccountService.js';
import { isUniqueConstraintError, realignCouponSequence } from './sequenceService.js';
import { PRIZE_NAMES } from './lotteryService.js';

type DropRewardConfig = {
  kind: 'COUPON' | 'POINTS' | 'LOTTERY_DRAW';
  key: string;
  label: string;
  weight: number;
  couponType?: CouponType;
  points?: number;
  lotteryPrizeName?: string;
  prizeName?: string;
};

const BASE_REWARD_POOL: Record<string, DropRewardConfig> = {
  CAKE_VOUCHER: { kind: 'COUPON', key: 'CAKE_VOUCHER', couponType: CouponType.CAKE_VOUCHER, label: '小蛋糕代金券', weight: 10, prizeName: PRIZE_NAMES.CAKE_VOUCHER },
  LOLLIPOP_VOUCHER: { kind: 'COUPON', key: 'LOLLIPOP_VOUCHER', couponType: CouponType.LOLLIPOP_VOUCHER, label: '棒棒糖代金券', weight: 90, prizeName: PRIZE_NAMES.LOLLIPOP_VOUCHER },
  PERFUME_VOUCHER: { kind: 'COUPON', key: 'PERFUME_VOUCHER', couponType: CouponType.PERFUME_VOUCHER, label: '香水代金券', weight: 1, prizeName: PRIZE_NAMES.PERFUME_VOUCHER },
  COMMISSION_MINUS1_VOUCHER: {
    kind: 'COUPON',
    key: 'COMMISSION_MINUS1_VOUCHER',
    couponType: CouponType.COMMISSION_MINUS1_VOUCHER,
    label: '抽成降1%券',
    weight: 1,
    prizeName: PRIZE_NAMES.COMMISSION_MINUS1_VOUCHER,
  },
  DOUBLE_SPEND_5000_VOUCHER: {
    kind: 'COUPON',
    key: 'DOUBLE_SPEND_5000_VOUCHER',
    couponType: CouponType.DOUBLE_SPEND_5000_VOUCHER,
    label: '双倍消费5000券',
    weight: 5,
    prizeName: PRIZE_NAMES.DOUBLE_SPEND_5000_VOUCHER,
  },
  DOUBLE_FLOW_5000_VOUCHER: {
    kind: 'COUPON',
    key: 'DOUBLE_FLOW_5000_VOUCHER',
    couponType: CouponType.DOUBLE_FLOW_5000_VOUCHER,
    label: '双倍流水5000券',
    weight: 5,
    prizeName: PRIZE_NAMES.DOUBLE_FLOW_5000_VOUCHER,
  },
  LOTTERY_VOUCHER: {
    kind: 'COUPON',
    key: 'LOTTERY_VOUCHER',
    couponType: CouponType.LOTTERY_VOUCHER,
    label: '抽奖代金券',
    weight: 1,
    prizeName: PRIZE_NAMES.LOTTERY_VOUCHER,
  },
  BLOCK_STACK_VOUCHER: {
    kind: 'LOTTERY_DRAW',
    key: 'BLOCK_STACK_VOUCHER',
    lotteryPrizeName: PRIZE_NAMES.BLOCK_STACK_VOUCHER,
    label: '抽积木代金券',
    weight: 1,
    prizeName: PRIZE_NAMES.BLOCK_STACK_VOUCHER,
  },
  POINTS_100: {
    kind: 'POINTS',
    key: 'POINTS_100',
    label: '100锦鲤积分',
    points: 100,
    weight: 70,
  },
};

const DEFAULT_POOL = Object.values(BASE_REWARD_POOL);
const HARD_EXCLUDED_USER_IDS = new Set(['1421651539247894549']);
const CHAT_VOUCHER_EMOJI = '<a:chatVoucherEmoji:1441148279059386418>';

const isHttpUrl = (value: string | null | undefined) => /^https?:\/\/\S+$/i.test(value ?? '');

const getRewardImageFromEnv = (rewardKey: string): string | null => {
  const envKey = `CHAT_VOUCHER_DROP_IMAGE_${rewardKey}`;
  const value = process.env[envKey];
  return isHttpUrl(value) ? value!.trim() : null;
};

const parseNumber = (raw: string | undefined, fallback: number) => {
  if (!raw) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
};

const parseBoolean = (raw: string | undefined, fallback: boolean) => {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
};

const parseIdList = (raw: string | undefined): Set<string> => {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
};

const parsePoolFromEnv = (raw: string | undefined): DropRewardConfig[] => {
  if (!raw?.trim()) return DEFAULT_POOL;

  const pool: DropRewardConfig[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;

    const [keyRaw, weightRaw] = token.split(':');
    const key = keyRaw?.trim().toUpperCase();
    const base = key ? BASE_REWARD_POOL[key] : undefined;
    if (!base) continue;

    const weight = parseNumber(weightRaw?.trim(), base.weight);
    if (weight <= 0) continue;

    pool.push({
      kind: base.kind,
      key: base.key,
      label: base.label,
      weight,
      couponType: base.couponType,
      points: base.points,
      lotteryPrizeName: base.lotteryPrizeName,
      prizeName: base.prizeName,
    });
  }

  return pool.length ? pool : DEFAULT_POOL;
};

const pickByWeight = (pool: DropRewardConfig[]): DropRewardConfig | null => {
  if (!pool.length) return null;
  const total = pool.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
  if (total <= 0) return null;

  const roll = Math.random() * total;
  let cursor = 0;
  for (const row of pool) {
    cursor += Math.max(0, row.weight);
    if (roll <= cursor) return row;
  }
  return pool[pool.length - 1] ?? null;
};

const shouldIgnoreMessage = (message: Message, minLength: number) => {
  if (message.author.bot) return true;
  if (!message.guildId) return true;
  if (!message.content) return true;

  const content = message.content.trim();
  if (!content) return true;
  if (content.startsWith('!') || content.startsWith('/')) return true;
  if (content.length < minLength) return true;

  return false;
};

export function registerChatVoucherDropService(client: Client, prisma: PrismaClient) {
  const enabled = parseBoolean(process.env.CHAT_VOUCHER_DROP_ENABLED, true);
  if (!enabled) {
    console.log('[chat-drop] disabled');
    return;
  }

  const dropChance = Math.max(0, Math.min(1, parseNumber(process.env.CHAT_VOUCHER_DROP_CHANCE, 0.008)));
  const userCooldownMs = Math.max(0, parseNumber(process.env.CHAT_VOUCHER_DROP_USER_COOLDOWN_MS, 5 * 60 * 1000));
  const globalCooldownMs = Math.max(0, parseNumber(process.env.CHAT_VOUCHER_DROP_GLOBAL_COOLDOWN_MS, 60 * 1000));
  const minLength = Math.max(1, Math.floor(parseNumber(process.env.CHAT_VOUCHER_DROP_MIN_LEN, 4)));
  const dailyCap = Math.max(1, Math.floor(parseNumber(process.env.CHAT_VOUCHER_DROP_DAILY_CAP, 3)));
  const expireDays = Math.max(1, Math.floor(parseNumber(process.env.CHAT_VOUCHER_DROP_EXPIRE_DAYS, 30)));
  const includeChannels = parseIdList(process.env.CHAT_VOUCHER_DROP_CHANNEL_IDS);
  const excludeChannels = parseIdList(process.env.CHAT_VOUCHER_DROP_EXCLUDE_CHANNEL_IDS);
  const excludeUsers = parseIdList(process.env.CHAT_VOUCHER_DROP_EXCLUDE_USER_IDS);
  for (const id of HARD_EXCLUDED_USER_IDS) excludeUsers.add(id);
  const pool = parsePoolFromEnv(process.env.CHAT_VOUCHER_DROP_POOL);

  const userNextEligibleAt = new Map<string, number>();
  const userDailyCount = new Map<string, { day: string; count: number }>();
  let globalNextEligibleAt = 0;

  console.log('[chat-drop] enabled', {
    dropChance,
    userCooldownMs,
    globalCooldownMs,
    minLength,
    dailyCap,
    expireDays,
    pool: pool.map((p) => `${p.key}:${p.weight}`),
    includeChannels: includeChannels.size,
    excludeChannels: excludeChannels.size,
    excludeUsers: excludeUsers.size,
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (shouldIgnoreMessage(message, minLength)) return;

      const channelId = message.channelId;
      if (excludeChannels.has(channelId)) return;
      if (includeChannels.size > 0 && !includeChannels.has(channelId)) return;

      const nowMs = Date.now();
      if (nowMs < globalNextEligibleAt) return;

      const userId = message.author.id;
      if (excludeUsers.has(userId)) return;
      if (nowMs < (userNextEligibleAt.get(userId) ?? 0)) return;

      const dayKey = new Date().toISOString().slice(0, 10); // UTC day
      const userCounter = userDailyCount.get(userId);
      if (userCounter?.day === dayKey && userCounter.count >= dailyCap) return;

      if (Math.random() >= dropChance) return;

      const picked = pickByWeight(pool);
      if (!picked) return;
      let rewardImageUrl: string | null = getRewardImageFromEnv(picked.key);

      if (picked.kind === 'COUPON') {
        const identity = await ensureJinleeIdentityForDiscordTx(prisma, userId);
        const expiresAt = new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000);

        while (true) {
          try {
            await prisma.coupon.create({
              data: {
                discordId: userId,
                jinleeId: identity.jinleeId,
                type: picked.couponType!,
                status: CouponStatus.ACTIVE,
                expiresAt,
              },
            });
            break;
          } catch (err) {
            if (isUniqueConstraintError(err, 'id')) {
              await realignCouponSequence();
              continue;
            }
            throw err;
          }
        }
      } else if (picked.kind === 'POINTS') {
        const points = Math.max(1, Math.floor(picked.points ?? 0));
        await prisma.loyaltyPoint.upsert({
          where: { discordUserId: userId },
          create: { discordUserId: userId, points },
          update: { points: { increment: points } },
        });
      } else {
        const identity = await ensureJinleeIdentityForDiscordTx(prisma, userId);
        const prize = await prisma.lotteryPrize.findFirst({
          where: { name: picked.lotteryPrizeName },
          select: { id: true, pool: true, imageUrl: true },
        });
        if (!prize) return;
        if (!rewardImageUrl && isHttpUrl(prize.imageUrl)) rewardImageUrl = prize.imageUrl;

        const expiresAt = new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000);
        await prisma.lotteryDraw.create({
          data: {
            nonce: `chat-drop:${userId}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`,
            requestId: `chat-drop:${message.id}`,
            userId,
            jinleeId: identity.jinleeId,
            pool: prize.pool ?? LotteryPool.ADVANCED,
            prizeId: prize.id,
            cost: '0',
            random: Math.random(),
            status: LotteryStatus.UNUSED,
            code: `DROP-${crypto.randomBytes(4).toString('hex')}`,
            expiresAt,
          },
        });
      }

      if (!rewardImageUrl && picked.prizeName) {
        const prizeImage = await prisma.lotteryPrize.findFirst({
          where: { name: picked.prizeName },
          select: { imageUrl: true },
        });
        if (isHttpUrl(prizeImage?.imageUrl)) rewardImageUrl = prizeImage!.imageUrl!;
      }

      globalNextEligibleAt = nowMs + globalCooldownMs;
      userNextEligibleAt.set(userId, nowMs + userCooldownMs);
      if (!userCounter || userCounter.day !== dayKey) {
        userDailyCount.set(userId, { day: dayKey, count: 1 });
      } else {
        userDailyCount.set(userId, { day: dayKey, count: userCounter.count + 1 });
      }

      if (message.channel?.isTextBased()) {
        const isPoints = picked.kind === 'POINTS';
        const embed = new EmbedBuilder()
          .setColor(0xf4c542)
          .setTitle(`${CHAT_VOUCHER_EMOJI} 聊天掉落小彩蛋`)
          .setDescription(
            isPoints
              ? `${CHAT_VOUCHER_EMOJI} 恭喜 您 获得 **${picked.label}**，已自动到账。`
              : `${CHAT_VOUCHER_EMOJI} 恭喜 您 获得 **${picked.label} x1**。`
          )
          .setFooter({
            text: isPoints ? '继续聊天还有机会掉落更多奖励' : `有效期 ${expireDays} 天`,
          });
        if (rewardImageUrl) embed.setImage(rewardImageUrl);

        await message.reply({
          embeds: [embed],
          allowedMentions: { users: [userId], repliedUser: false },
        });
      }
    } catch (err) {
      console.error('[chat-drop] handle message failed:', err);
    }
  });
}
