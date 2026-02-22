import { AttachmentBuilder, Client, EmbedBuilder, Events, Guild, VoiceState } from 'discord.js';
import { Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import prisma from '../db/prisma.js';
import { adjustLoyaltyPointsTx } from './loyaltyPointService.js';

const DEC_ZERO = new Prisma.Decimal(0);
const DEFAULT_SECONDS_PER_POINT = 300;
const DEFAULT_MIN_SESSION_SECONDS = 60;
const DEFAULT_DAILY_CAP_POINTS = new Prisma.Decimal(120);
const DEFAULT_DAILY_CAP_OFFSET_MINUTES = 480; // Asia/Shanghai
const RULE_VERSION = 'voice-v1';
const BOT_AVATAR_PATH = path.resolve(process.cwd(), 'src', 'img', 'botAvatar.jpg');

const VOICE_POINTS_ENABLED = (process.env.VOICE_POINTS_ENABLED ?? 'true').toLowerCase() !== 'false';
const VOICE_POINTS_EXCLUDE_AFK = (process.env.VOICE_POINTS_EXCLUDE_AFK ?? 'true').toLowerCase() !== 'false';
const VOICE_POINTS_EXCLUDE_MUTED_DEAFENED =
  (process.env.VOICE_POINTS_EXCLUDE_MUTED_DEAFENED ?? 'true').toLowerCase() !== 'false';
const VOICE_POINTS_DM_ON_SETTLE = (process.env.VOICE_POINTS_DM_ON_SETTLE ?? 'true').toLowerCase() !== 'false';
const VOICE_POINTS_SECONDS_PER_POINT = parsePositiveInt(
  process.env.VOICE_POINTS_SECONDS_PER_POINT,
  DEFAULT_SECONDS_PER_POINT,
);
const VOICE_POINTS_MIN_SESSION_SECONDS = parsePositiveInt(
  process.env.VOICE_POINTS_MIN_SESSION_SECONDS,
  DEFAULT_MIN_SESSION_SECONDS,
);
const VOICE_POINTS_DAILY_CAP_POINTS = parsePositiveDecimal(
  process.env.VOICE_POINTS_DAILY_CAP_POINTS,
  DEFAULT_DAILY_CAP_POINTS,
);
const VOICE_POINTS_DAILY_CAP_OFFSET_MINUTES = parseIntOrFallback(
  process.env.VOICE_POINTS_DAILY_CAP_OFFSET_MINUTES,
  DEFAULT_DAILY_CAP_OFFSET_MINUTES,
);
const VOICE_POINTS_GUILD_IDS = new Set(
  (process.env.VOICE_POINTS_GUILD_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

type OpenSession = {
  id: string;
  discordUserId: string;
  guildId: string;
  channelId: string;
  joinedAt: Date;
};

const activeSessionCache = new Map<string, OpenSession>();

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseIntOrFallback(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parsePositiveDecimal(raw: string | undefined, fallback: Prisma.Decimal): Prisma.Decimal {
  if (!raw?.trim()) return fallback;
  try {
    const val = new Prisma.Decimal(raw.trim());
    if (val.lte(0)) return fallback;
    return val;
  } catch {
    return fallback;
  }
}

function getDayWindowUtcByOffset(base: Date, offsetMinutes: number): { startUtc: Date; endUtc: Date } {
  const shifted = new Date(base.getTime() + offsetMinutes * 60_000);
  const shiftedMidnightUtcMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const startUtc = new Date(shiftedMidnightUtcMs - offsetMinutes * 60_000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

function isGuildAllowed(guildId: string | null | undefined): guildId is string {
  if (!guildId) return false;
  if (VOICE_POINTS_GUILD_IDS.size === 0) return true;
  return VOICE_POINTS_GUILD_IDS.has(guildId);
}

function isEligibleChannel(guild: Guild, channelId: string | null): channelId is string {
  if (!channelId) return false;
  if (!VOICE_POINTS_EXCLUDE_AFK) return true;
  return guild.afkChannelId !== channelId;
}

function isMutedOrDeafened(state: VoiceState): boolean {
  return Boolean(state.selfMute || state.serverMute || state.selfDeaf || state.serverDeaf);
}

function isStateEligible(state: VoiceState): boolean {
  if (!isEligibleChannel(state.guild, state.channelId)) return false;
  if (VOICE_POINTS_EXCLUDE_MUTED_DEAFENED && isMutedOrDeafened(state)) return false;
  return true;
}

function computeAward(joinedAt: Date, endedAt: Date): { eligibleSeconds: number; points: Prisma.Decimal } {
  const elapsedSeconds = Math.max(0, Math.floor((endedAt.getTime() - joinedAt.getTime()) / 1000));
  if (elapsedSeconds < VOICE_POINTS_MIN_SESSION_SECONDS) {
    return { eligibleSeconds: elapsedSeconds, points: DEC_ZERO };
  }

  const points = new Prisma.Decimal(elapsedSeconds)
    .div(VOICE_POINTS_SECONDS_PER_POINT)
    .toDecimalPlaces(4, Prisma.Decimal.ROUND_DOWN);
  return { eligibleSeconds: elapsedSeconds, points: points.lt(0) ? DEC_ZERO : points };
}

async function fetchOpenSession(discordUserId: string): Promise<OpenSession | null> {
  const cached = activeSessionCache.get(discordUserId);
  if (cached) return cached;

  const session = await prisma.voicePointSession.findFirst({
    where: { discordUserId, leftAt: null },
    orderBy: { joinedAt: 'desc' },
    select: { id: true, discordUserId: true, guildId: true, channelId: true, joinedAt: true },
  });
  if (!session) return null;

  activeSessionCache.set(discordUserId, session);
  return session;
}

async function sendSettleDm(
  client: Client,
  discordUserId: string,
  points: Prisma.Decimal,
): Promise<void> {
  if (!VOICE_POINTS_DM_ON_SETTLE) return;
  if (points.lte(0)) return;

  try {
    const user = await client.users.fetch(discordUserId);
    const embed = new EmbedBuilder()
      .setTitle('语音频道挂机积分结算')
      .setDescription(`+${points.toFixed(4)} 积分`);
    const files = fs.existsSync(BOT_AVATAR_PATH)
      ? [new AttachmentBuilder(BOT_AVATAR_PATH, { name: 'botAvatar.jpg' })]
      : [];
    if (files.length > 0) {
      embed.setThumbnail('attachment://botAvatar.jpg');
    }
    await user.send({ embeds: [embed], ...(files.length ? { files } : {}) });
  } catch (err) {
    console.error('[voice-points] send settle dm failed:', { discordUserId, err });
  }
}

async function closeSession(
  client: Client,
  session: OpenSession,
  closeReason: string,
  endedAt: Date,
): Promise<void> {
  const { eligibleSeconds, points } = computeAward(session.joinedAt, endedAt);
  let settled = false;
  let awardedPoints = DEC_ZERO;

  await prisma.$transaction(async (tx) => {
    if (points.gt(0)) {
      // Serialize per user to keep daily cap accurate under concurrent settles.
      await tx.$queryRaw`SELECT 1 FROM "Member" WHERE "discordUserId" = ${session.discordUserId} FOR UPDATE`;
      const { startUtc, endUtc } = getDayWindowUtcByOffset(
        endedAt,
        VOICE_POINTS_DAILY_CAP_OFFSET_MINUTES,
      );
      const todayAwarded = await tx.voicePointLedger.aggregate({
        where: {
          discordUserId: session.discordUserId,
          createdAt: { gte: startUtc, lt: endUtc },
        },
        _sum: { points: true },
      });
      const usedToday = new Prisma.Decimal(todayAwarded._sum.points ?? 0);
      const remaining = VOICE_POINTS_DAILY_CAP_POINTS.sub(usedToday);
      if (remaining.lte(0)) {
        awardedPoints = DEC_ZERO;
      } else {
        awardedPoints = points.gt(remaining) ? remaining : points;
      }
    }

    const updated = await tx.voicePointSession.updateMany({
      where: { id: session.id, leftAt: null },
      data: {
        leftAt: endedAt,
        eligibleSeconds,
        pointsAwarded: awardedPoints,
        closeReason,
      },
    });

    if (updated.count === 0) return;
    settled = true;

    if (awardedPoints.gt(0)) {
      await adjustLoyaltyPointsTx(tx, session.discordUserId, awardedPoints);
      await tx.voicePointLedger.create({
        data: {
          sessionId: session.id,
          discordUserId: session.discordUserId,
          guildId: session.guildId,
          channelId: session.channelId,
          durationSeconds: eligibleSeconds,
          points: awardedPoints,
          ruleVersion: RULE_VERSION,
        },
      });
    }
  });

  activeSessionCache.delete(session.discordUserId);
  if (settled) {
    await sendSettleDm(client, session.discordUserId, awardedPoints);
  }
}

async function openSession(
  client: Client,
  discordUserId: string,
  guildId: string,
  channelId: string,
  joinedAt: Date,
): Promise<void> {
  const current = await fetchOpenSession(discordUserId);
  if (current) {
    if (current.guildId === guildId && current.channelId === channelId) {
      return;
    }
    await closeSession(client, current, 'channel_switch', joinedAt);
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.member.upsert({
      where: { discordUserId },
      update: {},
      create: { discordUserId },
    });

    return tx.voicePointSession.create({
      data: {
        discordUserId,
        guildId,
        channelId,
        joinedAt,
      },
      select: {
        id: true,
        discordUserId: true,
        guildId: true,
        channelId: true,
        joinedAt: true,
      },
    });
  });

  activeSessionCache.set(discordUserId, created);
}

function deriveCloseReason(session: OpenSession, newState: VoiceState): string {
  if (!newState.channelId) return 'leave_voice';
  if (!isGuildAllowed(newState.guild.id)) return 'guild_not_allowed';
  if (VOICE_POINTS_EXCLUDE_AFK && newState.guild.afkChannelId === newState.channelId) return 'afk_channel';
  if (VOICE_POINTS_EXCLUDE_MUTED_DEAFENED && isMutedOrDeafened(newState)) return 'mute_or_deafen';
  if (session.guildId !== newState.guild.id || session.channelId !== newState.channelId) return 'channel_switch';
  return 'not_eligible';
}

async function handleVoiceStateUpdate(client: Client, oldState: VoiceState, newState: VoiceState): Promise<void> {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const guild = newState.guild ?? oldState.guild;
  if (!guild?.id) return;
  const endedAt = new Date();
  const guildAllowed = isGuildAllowed(guild.id);
  const shouldBeOpen = guildAllowed && isStateEligible(newState);
  const current = await fetchOpenSession(member.id);

  if (current) {
    const stillSameChannel =
      current.guildId === guild.id &&
      current.channelId === (newState.channelId ?? '');

    if (!shouldBeOpen) {
      await closeSession(client, current, deriveCloseReason(current, newState), endedAt);
      return;
    }

    if (!stillSameChannel) {
      await closeSession(client, current, 'channel_switch', endedAt);
      if (newState.channelId) {
        await openSession(client, member.id, guild.id, newState.channelId, endedAt);
      }
      return;
    }

    return;
  }

  if (shouldBeOpen && newState.channelId) {
    await openSession(client, member.id, guild.id, newState.channelId, endedAt);
  }
}

async function resetOpenSessions(): Promise<void> {
  const now = new Date();
  const result = await prisma.voicePointSession.updateMany({
    where: { leftAt: null },
    data: {
      leftAt: now,
      eligibleSeconds: 0,
      pointsAwarded: DEC_ZERO,
      closeReason: 'service_restart',
    },
  });
  if (result.count > 0) {
    console.log(`[voice-points] reset ${result.count} open sessions on startup`);
  }
}

async function seedCurrentVoiceSessions(client: Client): Promise<void> {
  const now = new Date();
  let seeded = 0;
  const processedUsers = new Set<string>();

  for (const guild of client.guilds.cache.values()) {
    if (!isGuildAllowed(guild.id)) continue;

    for (const state of guild.voiceStates.cache.values()) {
      if (!isStateEligible(state)) continue;
      const channelId = state.channelId;
      if (!channelId) continue;

      const userId = state.id;
      if (processedUsers.has(userId)) continue;
      processedUsers.add(userId);

      const member = state.member ?? (await guild.members.fetch(userId).catch(() => null));
      if (!member || member.user.bot) continue;

      await openSession(client, userId, guild.id, channelId, now);
      seeded += 1;
    }
  }

  console.log(`[voice-points] seeded ${seeded} active voice sessions`);
}

async function recoverVoiceSessions(client: Client): Promise<void> {
  activeSessionCache.clear();
  await resetOpenSessions();
  await seedCurrentVoiceSessions(client);
}

export function registerVoicePointService(client: Client): void {
  if (!VOICE_POINTS_ENABLED) {
    console.log('[voice-points] disabled');
    return;
  }

  console.log(
    `[voice-points] enabled (secondsPerPoint=${VOICE_POINTS_SECONDS_PER_POINT}, minSessionSeconds=${VOICE_POINTS_MIN_SESSION_SECONDS}, dailyCap=${VOICE_POINTS_DAILY_CAP_POINTS.toString()}, capOffsetMinutes=${VOICE_POINTS_DAILY_CAP_OFFSET_MINUTES}, excludeAfk=${VOICE_POINTS_EXCLUDE_AFK}, excludeMutedDeafened=${VOICE_POINTS_EXCLUDE_MUTED_DEAFENED})`,
  );

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(client, oldState, newState).catch((err) =>
      console.error('[voice-points] voiceStateUpdate failed:', err),
    );
  });

  client.once(Events.ClientReady, () => {
    recoverVoiceSessions(client).catch((err) =>
      console.error('[voice-points] startup recovery failed:', err),
    );
  });
}
