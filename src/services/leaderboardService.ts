import { Client, EmbedBuilder, TextChannel, userMention } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';

const ROME_TZ = 'Europe/Rome';
const CONSUME_CHANNEL_ID = '1451405411424141372';
const INCOME_CHANNEL_ID = '1451405489635065866';
const POLL_INTERVAL_MS = 60 * 1000; // every minute for testing
const RANK_LIMIT = 10;
const EXCLUDED_USER_IDS = new Set<string>([
  '1421651539247894549',
  '525770714574225408',
]);

type SnapshotRow = {
  discordUserId: string;
  totalEarn: Prisma.Decimal;
  totalSpent: Prisma.Decimal;
};

type CurrentRow = SnapshotRow;

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

const stripExcluded = <T extends { discordUserId: string }>(rows: T[]): T[] =>
  rows.filter((row) => !EXCLUDED_USER_IDS.has(row.discordUserId));

const crown = '<a:55:1422336379966324847>';
const moon = '<a:779626:1455781398924230787>';
const star = '<a:36:1422326912327618775>';

const formatIncomeRankingText = (entries: LeaderboardEntry[]) => {
  if (!entries.length) return '暂无数据';
  const ordinal = ['第1名', '第2名', '第3名', '第4名', '第5名'];
  const lines: string[] = [];

  entries.forEach((entry, idx) => {
    const rankLabel = ordinal[idx] ?? `第${idx + 1}名`;
    const prefix = idx <= 2 ? moon : star;
    const mention = idx <= 2 ? ` ${userMention(entry.discordUserId)}` : '';
    const label = `${rankLabel}：`;
    const parts = [prefix, label, `${entry.displayName}${mention}`].filter(Boolean);
    let line = parts.join(' ');
    if (idx === 0) line = `**${line}**`; // 最大强调（去除下划线）
    else if (idx === 1 || idx === 2) line = `**${line}**`; // 中号
    // 第四、第五名及之后保持小号

    lines.push(line);
    if (idx <= 2) lines.push(''); // 前三名之间空一行，第三名与第四名之间也空一行
  });

  return lines.join('\n');
};

const formatSpendRankingText = (entries: LeaderboardEntry[]) => formatIncomeRankingText(entries);

async function loadSnapshotForDay(targetDayStart: Date) {
  await ensureSnapshot(targetDayStart);

  const startRows = await prisma.dailySnapshot.findMany({
    where: { date: targetDayStart },
    select: { discordUserId: true, totalEarn: true, totalSpent: true },
  });

  return stripExcluded(startRows);
}

async function loadSnapshotsForDayRange(targetDayStart: Date) {
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

  return { startRows: stripExcluded(startRows), endRows: stripExcluded(endRows) };
}

function buildEntries(
  startRows: SnapshotRow[],
  endRows: CurrentRow[],
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

const formatSpendEmbed = (title: string, entries: LeaderboardEntry[]) => {
  const lines = formatSpendRankingText(entries);
  return new EmbedBuilder().setTitle(title).setDescription(lines);
};

const formatIncomeEmbed = (title: string, entries: LeaderboardEntry[]) => {
  const bannerUrl =
    'https://cdn.discordapp.com/attachments/1445864521343439019/1455763863550038106/21.gif?ex=6955e93f&is=695497bf&hm=3efd1693fdae89e1e6d0e2d493b69171cf66f1dd337f15aceb4b3ea0d328fc4b';
  const lines = formatIncomeRankingText(entries);
  return new EmbedBuilder().setTitle(title).setDescription(lines).setImage(bannerUrl);
};

async function sendLeaderboard(
  client: Client,
  channelId: string,
  embed: EmbedBuilder
) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    console.error('[leaderboard] send failed', { channelId, err });
  }
}

async function generateDailyAndPost(client: Client) {
  const now = new Date();
  const todayStart = romeDateStart(now);
  const targetDayStart = addDaysUtc(todayStart, -1);
  const dateLabel = romeDateLabel(targetDayStart);

  const { startRows, endRows } = await loadSnapshotsForDayRange(targetDayStart);

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

  const spendEmbed = formatSpendEmbed(
    `${crown} 老板消费榜单（${dateLabel}） ${crown}`,
    spendTop
  );
  const incomeEmbed = formatIncomeEmbed(
    `${crown} 陪玩人气日榜（${dateLabel}） ${crown}`,
    incomeTop
  );

  await Promise.all([
    sendLeaderboard(client, CONSUME_CHANNEL_ID, spendEmbed),
    sendLeaderboard(client, INCOME_CHANNEL_ID, incomeEmbed),
  ]);
}

async function generateRealtimeAndPost(client: Client) {
  const now = new Date();
  const todayStart = romeDateStart(now);
  const dateLabel = romeDateLabel(todayStart);

  const startRows = await loadSnapshotForDay(todayStart);
  const endRows: CurrentRow[] = await prisma.member.findMany({
    select: {
      discordUserId: true,
      totalSpent: true,
      peiwan: { select: { totalEarn: true } },
    },
  }).then((rows) =>
    rows.map((row) => ({
      discordUserId: row.discordUserId,
      totalSpent: row.totalSpent,
      totalEarn: row.peiwan?.totalEarn ?? new Prisma.Decimal(0),
    }))
  );
  const filteredEndRows = stripExcluded(endRows);

  const userIds = Array.from(
    new Set([...startRows, ...filteredEndRows].map((row) => row.discordUserId))
  );
  const members = await prisma.member.findMany({
    where: { discordUserId: { in: userIds } },
    select: { discordUserId: true, serverDisplayName: true },
  });
  const displayMap = new Map(
    members.map((m) => [m.discordUserId, m.serverDisplayName ?? m.discordUserId])
  );

  const entries = buildEntries(startRows, filteredEndRows, displayMap);
  const spendTop = entries
    .filter((e) => e.deltaSpent.gt(0))
    .sort((a, b) => b.deltaSpent.cmp(a.deltaSpent))
    .slice(0, RANK_LIMIT);
  const incomeTop = entries
    .filter((e) => e.deltaEarn.gt(0))
    .sort((a, b) => b.deltaEarn.cmp(a.deltaEarn))
    .slice(0, RANK_LIMIT);

  const spendEmbed = formatSpendEmbed(
    `${crown} 老板消费榜单（${dateLabel}） ${crown}`,
    spendTop
  );
  const incomeEmbed = formatIncomeEmbed(
    `${crown} 陪玩人气日榜（${dateLabel}） ${crown}`,
    incomeTop
  )

  await Promise.all([
    sendLeaderboard(client, CONSUME_CHANNEL_ID, spendEmbed),
    sendLeaderboard(client, INCOME_CHANNEL_ID, incomeEmbed),
  ]);
}

let running = false;

export function startLeaderboardScheduler(client: Client) {
  const runRealtime = async () => {
    if (running) return;
    running = true;
    try {
      await generateRealtimeAndPost(client);
    } catch (err) {
      console.error('[leaderboard] generate failed', err);
    } finally {
      running = false;
    }
  };

  setInterval(runRealtime, POLL_INTERVAL_MS);
  runRealtime().catch((err) => console.error('[leaderboard] initial run failed', err));

  const scheduleDaily = () => {
    const now = new Date();
    const todayStart = romeDateStart(now);
    const nextDayStart = addDaysUtc(todayStart, 1);
    const delay = nextDayStart.getTime() - now.getTime();
    setTimeout(() => {
      generateDailyAndPost(client).catch((err) => console.error('[leaderboard] daily failed', err));
      setInterval(() => {
        generateDailyAndPost(client).catch((err) =>
          console.error('[leaderboard] daily failed', err)
        );
      }, 24 * 60 * 60 * 1000);
    }, Math.max(1000, delay));
  };

  scheduleDaily();
}
