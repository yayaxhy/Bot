import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';

const ROME_TZ = 'Europe/Rome';
const CONSUME_CHANNEL_ID = '1451405411424141372';
const INCOME_CHANNEL_ID = '1451405489635065866';
const POLL_INTERVAL_MS = 60 * 1000; // every minute for testing
const RANK_LIMIT = 10;

type SnapshotRow = {
  discordUserId: string;
  totalEarn: Prisma.Decimal;
  totalSpent: Prisma.Decimal;
};

type LeaderboardEntry = {
  discordUserId: string;
  displayName: string;
  deltaEarn: Prisma.Decimal;
  deltaSpent: Prisma.Decimal;
};

const formatRomeParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROME_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return { year, month, day };
};

const romeDateStart = (date: Date) => {
  const { year, month, day } = formatRomeParts(date);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
};

const romeDateLabel = (date: Date) => {
  const { year, month, day } = formatRomeParts(date);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
};

const addDaysUtc = (date: Date, days: number) => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

async function ensureSnapshot(date: Date) {
  const existing = await prisma.dailySnapshot.findFirst({ where: { date } });
  if (existing) return;

  const members = await prisma.member.findMany({
    select: {
      discordUserId: true,
      totalSpent: true,
      peiwan: { select: { totalEarn: true } },
    },
  });
  if (members.length === 0) return;

  const data = members.map((m) => ({
    date,
    discordUserId: m.discordUserId,
    totalEarn: m.peiwan?.totalEarn ?? new Prisma.Decimal(0),
    totalSpent: m.totalSpent,
  }));

  await prisma.dailySnapshot.createMany({ data, skipDuplicates: true });
}

const toMap = (rows: SnapshotRow[]) => {
  const map = new Map<string, SnapshotRow>();
  rows.forEach((row) => map.set(row.discordUserId, row));
  return map;
};

async function loadSnapshotsForDay(targetDayStart: Date) {
  const nextDayStart = addDaysUtc(targetDayStart, 1);

  await Promise.all([ensureSnapshot(targetDayStart), ensureSnapshot(nextDayStart)]);

  const [startRows, endRows] = await Promise.all([
    prisma.dailySnapshot.findMany({
      where: { date: targetDayStart },
      select: { discordUserId: true, totalEarn: true, totalSpent: true },
    }),
    prisma.dailySnapshot.findMany({
      where: { date: nextDayStart },
      select: { discordUserId: true, totalEarn: true, totalSpent: true },
    }),
  ]);

  return { startRows, endRows };
}

function buildEntries(
  startRows: SnapshotRow[],
  endRows: SnapshotRow[],
  displayMap: Map<string, string>
): LeaderboardEntry[] {
  const startMap = toMap(startRows);
  const entries: LeaderboardEntry[] = [];

  endRows.forEach((row) => {
    const prev = startMap.get(row.discordUserId);
    const deltaEarn = new Prisma.Decimal(row.totalEarn).sub(prev?.totalEarn ?? 0);
    const deltaSpent = new Prisma.Decimal(row.totalSpent).sub(prev?.totalSpent ?? 0);
    const displayName = displayMap.get(row.discordUserId) ?? row.discordUserId;
    entries.push({
      discordUserId: row.discordUserId,
      displayName,
      deltaEarn,
      deltaSpent,
    });
  });

  return entries;
}

const formatSpendEmbed = (dateLabel: string, entries: LeaderboardEntry[]) => {
  const lines =
    entries.length > 0
      ? entries.map((entry, idx) => `#${idx + 1} ${entry.displayName}`).join('\n')
      : '暂无消费数据';

  return new EmbedBuilder()
    .setTitle(`日消费榜（${dateLabel}，罗马时间）`)
    .setDescription(lines)
    .setTimestamp(new Date());
};

const formatIncomeEmbed = (dateLabel: string, entries: LeaderboardEntry[]) => {
  const lines =
    entries.length > 0
      ? entries.map((entry, idx) => `#${idx + 1} ${entry.displayName}`).join('\n')
      : '暂无收入数据';

  return new EmbedBuilder()
    .setTitle(`日收入榜（${dateLabel}，罗马时间）`)
    .setDescription(lines)
    .setTimestamp(new Date());
};

async function sendLeaderboard(
  client: Client,
  channelId: string,
  embed: EmbedBuilder
) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    await (channel as TextChannel).send({ content: '@everyone', embeds: [embed] });
  } catch (err) {
    console.error('[leaderboard] send failed', { channelId, err });
  }
}

async function generateAndPost(client: Client) {
  const now = new Date();
  const todayStart = romeDateStart(now);
  const targetDayStart = addDaysUtc(todayStart, -1);
  const dateLabel = romeDateLabel(targetDayStart);

  const { startRows, endRows } = await loadSnapshotsForDay(targetDayStart);

  const userIds = Array.from(
    new Set([...startRows, ...endRows].map((row) => row.discordUserId))
  );
  const members = await prisma.member.findMany({
    where: { discordUserId: { in: userIds } },
    select: { discordUserId: true, serverDisplayName: true },
  });
  const displayMap = new Map(
    members.map((m) => [m.discordUserId, m.serverDisplayName ?? m.discordUserId])
  );

  const entries = buildEntries(startRows, endRows, displayMap);
  const spendTop = entries
    .filter((e) => e.deltaSpent.gt(0))
    .sort((a, b) => b.deltaSpent.cmp(a.deltaSpent))
    .slice(0, RANK_LIMIT);
  const incomeTop = entries
    .filter((e) => e.deltaEarn.gt(0))
    .sort((a, b) => b.deltaEarn.cmp(a.deltaEarn))
    .slice(0, RANK_LIMIT);

  const spendEmbed = formatSpendEmbed(dateLabel, spendTop);
  const incomeEmbed = formatIncomeEmbed(dateLabel, incomeTop);

  await Promise.all([
    sendLeaderboard(client, CONSUME_CHANNEL_ID, spendEmbed),
    sendLeaderboard(client, INCOME_CHANNEL_ID, incomeEmbed),
  ]);
}

let running = false;

export function startLeaderboardScheduler(client: Client) {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await generateAndPost(client);
    } catch (err) {
      console.error('[leaderboard] generate failed', err);
    } finally {
      running = false;
    }
  };

  setInterval(run, POLL_INTERVAL_MS);
  run().catch((err) => console.error('[leaderboard] initial run failed', err));
}
