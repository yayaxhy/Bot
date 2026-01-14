import { Client, EmbedBuilder, TextChannel, userMention } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';

const ROME_TZ = 'Europe/Rome';
const DAILY_CONSUME_CHANNEL_ID = '1459927296025690242';
const DAILY_INCOME_CHANNEL_ID = '1459927770477101168';
const WEEKLY_CONSUME_CHANNEL_ID = '1451405411424141372';
const WEEKLY_INCOME_CHANNEL_ID = '1451405489635065866';
const MONTHLY_CONSUME_CHANNEL_ID = '1451405411424141372';
const MONTHLY_INCOME_CHANNEL_ID = '1451405489635065866';
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

type LeaderboardKind = 'daily' | 'weekly' | 'monthly';

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
  // Start with midnight UTC for that Rome calendar day…
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // …then adjust by the Rome offset for that date (handles DST).
  const romeGuess = new Date(new Date(utcGuess).toLocaleString('en-US', { timeZone: ROME_TZ }));
  const offsetMs = utcGuess - romeGuess.getTime();
  return new Date(utcGuess + offsetMs);
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

const romeDateFromParts = (year: number, month: number, day: number) => {
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const romeGuess = new Date(new Date(utcGuess).toLocaleString('en-US', { timeZone: ROME_TZ }));
  const offsetMs = utcGuess - romeGuess.getTime();
  return new Date(utcGuess + offsetMs);
};

const romeWeekStart = (date: Date) => {
  const romeNow = new Date(date.toLocaleString('en-US', { timeZone: ROME_TZ }));
  const day = romeNow.getDay(); // 0 Sun ... 6 Sat
  const daysSinceMonday = (day + 6) % 7;
  return addDaysUtc(romeDateStart(date), -daysSinceMonday);
};

const romeMonthStart = (date: Date) => {
  const { year, month } = formatRomeParts(date);
  return romeDateFromParts(year, month, 1);
};

const romeNextMonthStart = (date: Date) => {
  const { year, month } = formatRomeParts(date);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return romeDateFromParts(nextYear, nextMonth, 1);
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
const redCrown = '<a:513:1422336441064620052>';
const spinCrown = '<a:98488firecrow:1422362470218989648>';
const redStar = '<a:33:1422326883344711762>';
const ANON_SPEND_USER_IDS = new Set<string>(['775769771475075144']);

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

const formatSpendRankingText = (entries: LeaderboardEntry[]) => {
  if (!entries.length) return '暂无数据';
  const lines: string[] = [''];

  entries.forEach((entry, idx) => {
    const rank = idx + 1;
    const prefix = rank <= 3 ? spinCrown : redStar;
    const isAnon = ANON_SPEND_USER_IDS.has(entry.discordUserId);
    const mention = rank <= 3 && !isAnon ? ` ${userMention(entry.discordUserId)}` : '';
    const displayName = isAnon ? '匿名老板' : entry.displayName;
    lines.push(`${prefix} 第${rank}名：${displayName}${mention}`);
    if (rank <= 3) lines.push('');
  });

  return lines.join('\n');
};

async function loadSnapshotForDay(targetDayStart: Date) {
  await ensureSnapshot(targetDayStart);

  const startRows = await prisma.dailySnapshot.findMany({
    where: { date: targetDayStart },
    select: { discordUserId: true, totalEarn: true, totalSpent: true },
  });

  return stripExcluded(startRows);
}

async function loadSnapshotsForRange(start: Date, end: Date) {
  await Promise.all([ensureSnapshot(start), ensureSnapshot(end)]);

  const [startRows, endRows] = await Promise.all([
    prisma.dailySnapshot.findMany({
      where: { date: start },
      select: { discordUserId: true, totalEarn: true, totalSpent: true },
    }),
    prisma.dailySnapshot.findMany({
      where: { date: end },
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

async function loadDisplayMap(startRows: SnapshotRow[], endRows: SnapshotRow[]) {
  const userIds = Array.from(
    new Set([...startRows, ...endRows].map((row) => row.discordUserId))
  );
  if (!userIds.length) return new Map<string, string>();

  const members = await prisma.member.findMany({
    where: { discordUserId: { in: userIds } },
    select: { discordUserId: true, serverDisplayName: true },
  });
  return new Map(
    members.map((m) => [m.discordUserId, m.serverDisplayName ?? m.discordUserId])
  );
}

const formatSpendEmbed = (title: string, entries: LeaderboardEntry[]) => {
  const lines = formatSpendRankingText(entries);
  const bannerUrl =
    'https://cdn.discordapp.com/attachments/1445864521343439019/1456874910474571838/1-_.gif?ex=695de87e&is=695c96fe&hm=aba3f5f92935f16f0d795b9fdb5c59a0d353f7791b184df3ca27e37948bb2b36';
  return new EmbedBuilder().setTitle(title).setDescription(lines).setImage(bannerUrl);
};

const formatIncomeEmbed = (title: string, entries: LeaderboardEntry[]) => {
  const bannerUrl =
    'https://cdn.discordapp.com/attachments/1445864521343439019/1456874937234096159/2-_.gif?ex=695de884&is=695c9704&hm=47a66d65f47bd30df197958616a2e792a90f05c427a3c2d259efd8bbce9cb75d';
  const lines = formatIncomeRankingText(entries);
  return new EmbedBuilder().setTitle(title).setDescription(lines).setImage(bannerUrl);
};

async function hasLeaderboardPost(kind: LeaderboardKind, periodStart: Date) {
  const existing = await prisma.leaderboardPost.findUnique({
    where: { kind_periodStart: { kind, periodStart } },
    select: { id: true },
  });
  return !!existing;
}

async function recordLeaderboardPost(kind: LeaderboardKind, periodStart: Date) {
  try {
    await prisma.leaderboardPost.create({
      data: { kind, periodStart },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return;
    }
    throw err;
  }
}

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
  if (await hasLeaderboardPost('daily', targetDayStart)) {
    return;
  }

  const endDayStart = addDaysUtc(targetDayStart, 1);
  const { startRows, endRows } = await loadSnapshotsForRange(targetDayStart, endDayStart);
  const displayMap = await loadDisplayMap(startRows, endRows);

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
    `${redCrown} 老板尊享日榜 ${redCrown}`,
    spendTop
  );
  const incomeEmbed = formatIncomeEmbed(
    `${crown} 陪玩人气日榜 ${crown}`,
    incomeTop
  );

  await Promise.all([
    sendLeaderboard(client, DAILY_CONSUME_CHANNEL_ID, spendEmbed),
    sendLeaderboard(client, DAILY_INCOME_CHANNEL_ID, incomeEmbed),
  ]);
  await recordLeaderboardPost('daily', targetDayStart);
}

async function generateWeeklyAndPost(client: Client) {
  const now = new Date();
  const thisWeekStart = romeWeekStart(now);
  const lastWeekStart = addDaysUtc(thisWeekStart, -7);
  if (await hasLeaderboardPost('weekly', lastWeekStart)) {
    return;
  }

  const { startRows, endRows } = await loadSnapshotsForRange(lastWeekStart, thisWeekStart);
  const displayMap = await loadDisplayMap(startRows, endRows);

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
    `${redCrown} 老板尊享周榜 ${redCrown}`,
    spendTop
  );
  const incomeEmbed = formatIncomeEmbed(
    `${crown} 陪玩人气周榜 ${crown}`,
    incomeTop
  );

  await Promise.all([
    sendLeaderboard(client, WEEKLY_CONSUME_CHANNEL_ID, spendEmbed),
    sendLeaderboard(client, WEEKLY_INCOME_CHANNEL_ID, incomeEmbed),
  ]);
  await recordLeaderboardPost('weekly', lastWeekStart);
}

async function generateMonthlyAndPost(client: Client) {
  const now = new Date();
  const thisMonthStart = romeMonthStart(now);
  const { year, month } = formatRomeParts(thisMonthStart);
  const lastMonthYear = month === 1 ? year - 1 : year;
  const lastMonth = month === 1 ? 12 : month - 1;
  const lastMonthStart = romeDateFromParts(lastMonthYear, lastMonth, 1);
  if (await hasLeaderboardPost('monthly', lastMonthStart)) {
    return;
  }

  const { startRows, endRows } = await loadSnapshotsForRange(lastMonthStart, thisMonthStart);
  const displayMap = await loadDisplayMap(startRows, endRows);

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
    `${redCrown} 老板尊享月榜 ${redCrown}`,
    spendTop
  );
  const incomeEmbed = formatIncomeEmbed(
    `${crown} 陪玩人气月榜 ${crown}`,
    incomeTop
  );

  await Promise.all([
    sendLeaderboard(client, MONTHLY_CONSUME_CHANNEL_ID, spendEmbed),
    sendLeaderboard(client, MONTHLY_INCOME_CHANNEL_ID, incomeEmbed),
  ]);
  await recordLeaderboardPost('monthly', lastMonthStart);
}


export function startLeaderboardScheduler(client: Client) {
  generateDailyAndPost(client).catch((err) =>
    console.error('[leaderboard] daily catch-up failed', err)
  );
  generateWeeklyAndPost(client).catch((err) =>
    console.error('[leaderboard] weekly catch-up failed', err)
  );
  generateMonthlyAndPost(client).catch((err) =>
    console.error('[leaderboard] monthly catch-up failed', err)
  );

  const scheduleDaily = () => {
    const now = new Date();
    const todayRomeStart = romeDateStart(now);
    const nextRomeMidnight = addDaysUtc(todayRomeStart, 1); // 00:00 Rome next day
    const delay = nextRomeMidnight.getTime() - now.getTime();

    const tick = () => {
      generateDailyAndPost(client).catch((err) =>
        console.error('[leaderboard] daily failed', err)
      );
    };

    setTimeout(() => {
      tick();
      setInterval(tick, 24 * 60 * 60 * 1000);
    }, Math.max(1000, delay));
  };

  scheduleDaily();

  const scheduleWeekly = () => {
    const now = new Date();
    const thisWeekStart = romeWeekStart(now);
    const nextWeekStart = addDaysUtc(thisWeekStart, 7);
    const delay = nextWeekStart.getTime() - now.getTime();

    const tick = () => {
      generateWeeklyAndPost(client).catch((err) =>
        console.error('[leaderboard] weekly failed', err)
      );
    };

    setTimeout(() => {
      tick();
      setInterval(tick, 7 * 24 * 60 * 60 * 1000);
    }, Math.max(1000, delay));
  };

  const scheduleMonthly = () => {
    const now = new Date();
    const nextMonthStart = romeNextMonthStart(now);
    const delay = nextMonthStart.getTime() - now.getTime();

    const tick = () => {
      generateMonthlyAndPost(client).catch((err) =>
        console.error('[leaderboard] monthly failed', err)
      );
    };

    setTimeout(() => {
      tick();
      scheduleMonthly();
    }, Math.max(1000, delay));
  };

  scheduleWeekly();
  scheduleMonthly();
}
