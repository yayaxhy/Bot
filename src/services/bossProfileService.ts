import { OrderStatus, PeiwanGameCode, PeiwanGameTier, Prisma, QuotationCode } from '@prisma/client';
import prisma from '../db/prisma.js';

type PortraitGameKey = PeiwanGameCode | 'STEAM';

type GameSignal = {
  key: PortraitGameKey;
  label: string;
  textHits: number;
  orderHits: number;
  weakOrderHits: number;
  snippets: string[];
};

export type BossPortrait = {
  bossId: string;
  displayName: string;
  totalSpent: number;
  totalBalance: number;
  totalRequestCount: number;
  sampledRequestCount: number;
  totalEndedOrderCount: number;
  sampledEndedOrderCount: number;
  averageSpendPerOrder: number;
  averageUnitPrice: number;
  averageClickCount: number;
  spendLevelLabel: string;
  topGames: string[];
  styleLabel: string;
  preferredCompanionLabel: string;
  activeWindowLabel: string;
  repeatWorkerLabel: string;
  rankLabel: string;
  evidenceLines: string[];
  firstSeenAt: Date | null;
};

export type StoredBossPortrait = {
  bossId: string;
  displayName: string;
  spendLevelLabel: string;
  styleLabel: string;
  preferredCompanionLabel: string;
  activeWindowLabel: string;
  repeatWorkerLabel: string;
  rankLabel: string;
  topGames: string[];
  evidenceLines: string[];
  totalSpentSnapshot: number;
  totalBalanceSnapshot: number;
  totalRequestCount: number;
  sampledRequestCount: number;
  totalEndedOrderCount: number;
  sampledEndedOrderCount: number;
  averageSpendPerOrder: number;
  averageUnitPrice: number;
  averageClickCount: number;
  firstSeenAt: Date | null;
  updatedAt: Date | null;
};

export type BossPortraitBatchMode = 'all' | 'missing';

export type BossPortraitBatchResult = {
  mode: BossPortraitBatchMode;
  candidateCount: number;
  createdCount: number;
  refreshedCount: number;
  failedCount: number;
  failedIds: string[];
};

const GAME_LABELS: Record<PortraitGameKey, string> = {
  [PeiwanGameCode.LOL]: 'LoL',
  [PeiwanGameCode.CSGO]: 'CS',
  [PeiwanGameCode.VAL]: '无畏契约',
  [PeiwanGameCode.NARAKA]: '永劫无间',
  [PeiwanGameCode.OW]: 'OW',
  [PeiwanGameCode.APEX]: 'Apex',
  [PeiwanGameCode.DELTA]: '三角洲',
  [PeiwanGameCode.MARVEL]: '漫威争锋',
  [PeiwanGameCode.TFT]: 'TFT',
  [PeiwanGameCode.TARKOV]: '塔科夫',
  [PeiwanGameCode.DOTA]: 'Dota',
  [PeiwanGameCode.COD]: 'COD',
  [PeiwanGameCode.CHAT]: '语聊',
  [PeiwanGameCode.SINGER]: '唱歌',
  STEAM: 'Steam/其他',
};

const QUOTATION_GAME_MAP: Partial<Record<QuotationCode, PortraitGameKey>> = {
  [QuotationCode.Q2]: PeiwanGameCode.LOL,
  [QuotationCode.Q3]: PeiwanGameCode.VAL,
  [QuotationCode.Q4]: PeiwanGameCode.DELTA,
  [QuotationCode.Q5]: PeiwanGameCode.CSGO,
  [QuotationCode.Q6]: PeiwanGameCode.NARAKA,
  [QuotationCode.Q7]: PeiwanGameCode.APEX,
  [QuotationCode.Q8]: PeiwanGameCode.OW,
  [QuotationCode.Q9]: PeiwanGameCode.TFT,
  [QuotationCode.Q10]: 'STEAM',
};

const GAME_PATTERNS: Array<{ key: PortraitGameKey; patterns: RegExp[] }> = [
  { key: PeiwanGameCode.LOL, patterns: [/英雄联盟/i, /\blol\b/i, /峡谷/i, /联盟/i] },
  { key: PeiwanGameCode.VAL, patterns: [/无畏契约/i, /valorant/i, /\bval\b/i, /瓦罗兰特/i] },
  { key: PeiwanGameCode.CSGO, patterns: [/\bcsgo\b/i, /\bcs2\b/i, /反恐精英/i, /counter[- ]?strike/i] },
  { key: PeiwanGameCode.OW, patterns: [/守望先锋/i, /overwatch/i, /\bow\b/i] },
  { key: PeiwanGameCode.APEX, patterns: [/\bapex\b/i, /艾派克斯/i] },
  { key: PeiwanGameCode.NARAKA, patterns: [/永劫/i, /\bnaraka\b/i] },
  { key: PeiwanGameCode.DELTA, patterns: [/三角洲/i, /\bdelta\b/i] },
  { key: PeiwanGameCode.MARVEL, patterns: [/漫威争锋/i, /\bmarvel\b/i] },
  { key: PeiwanGameCode.TFT, patterns: [/云顶/i, /\btft\b/i] },
  { key: PeiwanGameCode.TARKOV, patterns: [/塔科夫/i, /\btarkov\b/i] },
  { key: PeiwanGameCode.DOTA, patterns: [/刀塔/i, /\bdota\b/i] },
  { key: PeiwanGameCode.COD, patterns: [/使命召唤/i, /\bcod\b/i] },
  { key: PeiwanGameCode.CHAT, patterns: [/语聊/i, /陪聊/i, /哄睡/i, /连麦/i] },
  { key: PeiwanGameCode.SINGER, patterns: [/唱歌/i, /点歌/i, /歌手/i] },
  { key: 'STEAM', patterns: [/\bsteam\b/i, /单机/i] },
];

const RANK_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: '黑铁', patterns: [/黑铁/i, /\biron\b/i] },
  { label: '青铜', patterns: [/青铜/i, /\bbronze\b/i] },
  { label: '白银', patterns: [/白银/i, /\bsilver\b/i] },
  { label: '黄金', patterns: [/黄金/i, /\bgold\b/i] },
  { label: '铂金', patterns: [/铂金/i, /白金/i, /\bplat(?:inum)?\b/i] },
  { label: '翡翠', patterns: [/翡翠/i, /\bemerald\b/i] },
  { label: '钻石', patterns: [/钻石/i, /\bdiamond\b/i] },
  { label: '大师', patterns: [/大师(?!陪玩)/i, /\bmaster\b/i] },
  { label: '宗师', patterns: [/宗师/i, /\bgrandmaster\b/i] },
  { label: '王者', patterns: [/王者/i, /\bchallenger\b/i] },
  { label: '超凡', patterns: [/超凡/i, /\bascendant\b/i] },
  { label: '神话', patterns: [/神话/i, /\bimmortal\b/i] },
  { label: '辐能', patterns: [/辐能/i, /\bradiant\b/i] },
  { label: '猎杀', patterns: [/猎杀/i, /\bpredator\b/i] },
  { label: '前500', patterns: [/前500/i, /\btop ?500\b/i] },
  { label: '魔王护', patterns: [/魔王护/i] },
];

const CENTRAL_EUROPE_HOUR_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  // Use a Central European IANA zone so CET/CEST daylight saving is handled automatically.
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  hourCycle: 'h23',
});

const toNumber = (value: { toString(): string } | number | null | undefined) => {
  if (value == null) return 0;
  const numeric = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(numeric) ? numeric : 0;
};

function sanitizeText(raw: string | null | undefined) {
  return String(raw ?? '')
    .replace(/<@!?(\d+)>/g, '')
    .replace(/<@&(\d+)>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

function pushSnippet(signal: GameSignal, snippet: string) {
  if (!snippet) return;
  if (signal.snippets.includes(snippet)) return;
  if (signal.snippets.length >= 3) return;
  signal.snippets.push(snippet);
}

function getOrCreateGameSignal(store: Map<PortraitGameKey, GameSignal>, key: PortraitGameKey) {
  const existing = store.get(key);
  if (existing) return existing;
  const created: GameSignal = {
    key,
    label: GAME_LABELS[key],
    textHits: 0,
    orderHits: 0,
    weakOrderHits: 0,
    snippets: [],
  };
  store.set(key, created);
  return created;
}

function getCentralEuropeHour(date: Date) {
  const hourPart = CENTRAL_EUROPE_HOUR_FORMATTER
    .formatToParts(date)
    .find((part) => part.type === 'hour')?.value;
  const hour = Number.parseInt(hourPart ?? '', 10);
  return Number.isFinite(hour) ? hour : 0;
}

function getTimeBucketLabel(hour: number) {
  if (hour < 6) return '凌晨 00:00-05:59';
  if (hour < 12) return '上午 06:00-11:59';
  if (hour < 18) return '下午 12:00-17:59';
  return '晚上 18:00-23:59';
}

function maxTier(profiles: Array<{ tier: PeiwanGameTier }> | undefined) {
  const tierWeight: Record<PeiwanGameTier, number> = {
    [PeiwanGameTier.ENTERTAINMENT]: 1,
    [PeiwanGameTier.TRAINEE]: 2,
    [PeiwanGameTier.TECH]: 3,
    [PeiwanGameTier.MASTER]: 4,
    [PeiwanGameTier.DEMON_GUARD]: 5,
  };
  let best: PeiwanGameTier | null = null;
  for (const profile of profiles ?? []) {
    if (!best || tierWeight[profile.tier] > tierWeight[best]) {
      best = profile.tier;
    }
  }
  return best;
}

function collectMatchedGames(text: string) {
  const matched = new Set<PortraitGameKey>();
  for (const entry of GAME_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      matched.add(entry.key);
    }
  }
  return [...matched];
}

function collectMatchedRanks(text: string) {
  const matched = new Set<string>();
  for (const entry of RANK_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      matched.add(entry.label);
    }
  }
  return [...matched];
}

function summarizeSpendLevel(totalSpent: number, orderCount: number) {
  if (totalSpent >= 50000 || orderCount >= 120) return '重度高消费';
  if (totalSpent >= 15000 || orderCount >= 40) return '高消费';
  if (totalSpent >= 5000 || orderCount >= 15) return '中高消费';
  if (totalSpent >= 1000 || orderCount >= 5) return '中度消费';
  return '轻度消费';
}

function summarizePreferredCompanion(params: {
  techRequests: number;
  masterRequests: number;
  techOrders: number;
  masterOrders: number;
  entertainmentOrders: number;
  maleRequests: number;
  femaleRequests: number;
}) {
  const {
    techRequests,
    masterRequests,
    techOrders,
    masterOrders,
    entertainmentOrders,
    maleRequests,
    femaleRequests,
  } = params;

  const technicalScore = techRequests + techOrders;
  const masterScore = masterRequests + masterOrders;
  const entertainmentScore = entertainmentOrders;
  const genderLabel =
    maleRequests > femaleRequests
      ? '，更常点男陪'
      : femaleRequests > maleRequests
        ? '，更常点女陪'
        : '';

  if (masterScore > 0 && masterScore >= technicalScore) {
    return `明显偏大神单${genderLabel}`;
  }
  if (technicalScore > 0 && technicalScore >= entertainmentScore) {
    return `明显偏技术单${genderLabel}`;
  }
  if (entertainmentScore > 0) {
    return `偏娱乐/陪伴单${genderLabel}`;
  }
  if (genderLabel) {
    return `陪玩性别偏好较明显${genderLabel}`;
  }
  return '陪玩类型偏好暂不明显';
}

function summarizeStyle(params: {
  competitive: number;
  entertainment: number;
  social: number;
  techOrders: number;
  masterOrders: number;
}) {
  const { competitive, entertainment, social, techOrders, masterOrders } = params;
  const technicalBias = techOrders + masterOrders;

  if (social > 0 && social >= competitive && social >= entertainment) {
    return '更像社交陪伴型消费';
  }
  if (competitive > 0 || technicalBias > 0) {
    if (masterOrders > techOrders) return '更像高分/冲分需求';
    if (technicalBias > 0) return '更像排位上分需求';
    return '更像竞技开黑需求';
  }
  if (entertainment > 0) {
    return '更像娱乐开黑需求';
  }
  return '玩法风格信号不足';
}

function summarizeRanks(rankCounts: Map<string, number>, dominantGames: string[], competitive: number) {
  const topRanks = [...rankCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3);
  if (topRanks.length > 0) {
    return `明确提及 ${topRanks.map(([label, count]) => `${label}×${count}`).join('、')}`;
  }
  if (dominantGames.length > 0 && competitive > 0) {
    return `更像 ${dominantGames[0]} 排位/上分用户，但样本里没有明确段位词`;
  }
  return '样本里没有可靠的段位信号';
}

function formatDateShort(date: Date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}/${day}`;
}

export async function buildBossPortrait(bossId: string, sampleSize = 50): Promise<BossPortrait | null> {
  const take = Math.min(Math.max(sampleSize, 20), 200);

  const [
    member,
    totalRequestCount,
    requestLogs,
    totalEndedOrderCount,
    endedOrders,
    firstRequest,
    firstOrder,
  ] = await Promise.all([
    prisma.member.findUnique({
      where: { discordUserId: bossId },
      select: {
        serverDisplayName: true,
        totalSpent: true,
        totalBalance: true,
      },
    }),
    prisma.orderRequestLog.count({
      where: { ownerId: bossId },
    }),
    prisma.orderRequestLog.findMany({
      where: { ownerId: bossId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        content: true,
        createdAt: true,
        ownerDisplayName: true,
        _count: { select: { clicks: true } },
      },
    }),
    prisma.order.count({
      where: {
        hostId: bossId,
        status: OrderStatus.ENDED,
      },
    }),
    prisma.order.findMany({
      where: {
        hostId: bossId,
        status: OrderStatus.ENDED,
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        createdAt: true,
        quotationCode: true,
        unitPrice: true,
        grossAmount: true,
        workerId: true,
        worker: {
          select: { serverDisplayName: true },
        },
        peiwan: {
          select: {
            type: true,
            gameProfiles: {
              select: {
                gameCode: true,
                tier: true,
              },
            },
          },
        },
      },
    }),
    prisma.orderRequestLog.findFirst({
      where: { ownerId: bossId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.order.findFirst({
      where: { hostId: bossId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  if (!member && requestLogs.length === 0 && endedOrders.length === 0) {
    return null;
  }

  const displayName =
    member?.serverDisplayName?.trim()
    || requestLogs.find((row) => row.ownerDisplayName?.trim())?.ownerDisplayName?.trim()
    || bossId;

  const totalSpent = toNumber(member?.totalSpent);
  const totalBalance = toNumber(member?.totalBalance);

  const gameSignals = new Map<PortraitGameKey, GameSignal>();
  const rankCounts = new Map<string, number>();
  const workerCounts = new Map<string, { label: string; count: number }>();
  const timeBucketCounts = new Map<string, number>();
  const evidenceLines: string[] = [];

  let totalClicks = 0;
  let competitive = 0;
  let entertainment = 0;
  let social = 0;
  let techRequests = 0;
  let masterRequests = 0;
  let maleRequests = 0;
  let femaleRequests = 0;
  let techOrders = 0;
  let masterOrders = 0;
  let entertainmentOrders = 0;
  let grossTotal = 0;
  let unitPriceTotal = 0;

  for (const request of requestLogs) {
    const text = sanitizeText(request.content);
    if (!text) continue;

    totalClicks += request._count.clicks;
    const hour = getCentralEuropeHour(request.createdAt);
    const bucket = getTimeBucketLabel(hour);
    timeBucketCounts.set(bucket, (timeBucketCounts.get(bucket) ?? 0) + 1);

    const matchedGames = collectMatchedGames(text);
    const matchedRanks = collectMatchedRanks(text);

    for (const gameKey of matchedGames) {
      const signal = getOrCreateGameSignal(gameSignals, gameKey);
      signal.textHits += 1;
      pushSnippet(signal, text.slice(0, 48));
    }

    for (const rank of matchedRanks) {
      rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
    }

    if (/上分|冲分|晋级|排位|补位|双排|单排|定级|带飞/i.test(text)) competitive += 1;
    if (/娱乐|开黑|匹配|乱斗|休闲|轻松/i.test(text)) entertainment += 1;
    if (/语聊|陪聊|哄睡|聊天|唱歌|点歌|连麦/i.test(text)) social += 1;
    if (/技术陪玩|技术陪陪/i.test(text)) techRequests += 1;
    if (/大神陪玩|大神单|魔王护/i.test(text)) masterRequests += 1;
    if (/@?男陪陪|男陪玩|男陪/i.test(text)) maleRequests += 1;
    if (/@?女陪陪|女陪玩|女陪/i.test(text)) femaleRequests += 1;

    if (
      evidenceLines.length < 3 &&
      (matchedGames.length > 0 || matchedRanks.length > 0 || /上分|语聊|技术陪玩|大神陪玩/i.test(text))
    ) {
      evidenceLines.push(`${formatDateShort(request.createdAt)} ${text.slice(0, 50)}`);
    }
  }

  for (const order of endedOrders) {
    grossTotal += toNumber(order.grossAmount);
    unitPriceTotal += toNumber(order.unitPrice);

    const hour = getCentralEuropeHour(order.createdAt);
    const bucket = getTimeBucketLabel(hour);
    timeBucketCounts.set(bucket, (timeBucketCounts.get(bucket) ?? 0) + 1);

    const quotationGame = QUOTATION_GAME_MAP[order.quotationCode];
    if (quotationGame) {
      getOrCreateGameSignal(gameSignals, quotationGame).orderHits += 1;
    }

    const profiles = order.peiwan?.gameProfiles ?? [];
    if (!quotationGame && profiles.length === 1) {
      getOrCreateGameSignal(gameSignals, profiles[0].gameCode).weakOrderHits += 1;
    }

    const relevantProfiles =
      quotationGame && quotationGame !== 'STEAM'
        ? profiles.filter((profile) => profile.gameCode === quotationGame)
        : profiles;
    const topTier = maxTier(relevantProfiles);

    if (topTier === PeiwanGameTier.ENTERTAINMENT || order.peiwan?.type === '娱乐陪玩') {
      entertainmentOrders += 1;
    }
    if (topTier === PeiwanGameTier.TECH || topTier === PeiwanGameTier.TRAINEE || order.peiwan?.type === '技术陪玩') {
      techOrders += 1;
    }
    if (
      topTier === PeiwanGameTier.MASTER ||
      topTier === PeiwanGameTier.DEMON_GUARD ||
      order.peiwan?.type === '大神陪玩'
    ) {
      masterOrders += 1;
    }

    const workerLabel = order.worker?.serverDisplayName?.trim() || order.workerId;
    const workerEntry = workerCounts.get(order.workerId) ?? { label: workerLabel, count: 0 };
    workerEntry.count += 1;
    workerCounts.set(order.workerId, workerEntry);
  }

  const topGames = [...gameSignals.values()]
    .map((signal) => ({
      ...signal,
      score: signal.textHits * 3 + signal.orderHits * 2 + signal.weakOrderHits,
    }))
    .filter((signal) => signal.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((signal) => signal.label);

  const averageSpendPerOrder = endedOrders.length > 0 ? grossTotal / endedOrders.length : 0;
  const averageUnitPrice = endedOrders.length > 0 ? unitPriceTotal / endedOrders.length : 0;
  const averageClickCount = requestLogs.length > 0 ? totalClicks / requestLogs.length : 0;

  const topBucket = [...timeBucketCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? '时段信号不足';
  const repeatWorkers = [...workerCounts.values()]
    .filter((entry) => entry.count >= 2)
    .sort((left, right) => right.count - left.count)
    .slice(0, 2);
  const repeatWorkerLabel =
    repeatWorkers.length > 0
      ? repeatWorkers.map((entry) => `${entry.label}×${entry.count}`).join('、')
      : '复购对象暂不集中';

  const firstSeenCandidates = [firstRequest?.createdAt ?? null, firstOrder?.createdAt ?? null].filter(
    (value): value is Date => value instanceof Date,
  );
  const firstSeenAt =
    firstSeenCandidates.length > 0
      ? new Date(Math.min(...firstSeenCandidates.map((item) => item.getTime())))
      : null;

  return {
    bossId,
    displayName,
    totalSpent,
    totalBalance,
    totalRequestCount,
    sampledRequestCount: requestLogs.length,
    totalEndedOrderCount,
    sampledEndedOrderCount: endedOrders.length,
    averageSpendPerOrder,
    averageUnitPrice,
    averageClickCount,
    spendLevelLabel: summarizeSpendLevel(totalSpent, totalEndedOrderCount),
    topGames,
    styleLabel: summarizeStyle({
      competitive,
      entertainment,
      social,
      techOrders,
      masterOrders,
    }),
    preferredCompanionLabel: summarizePreferredCompanion({
      techRequests,
      masterRequests,
      techOrders,
      masterOrders,
      entertainmentOrders,
      maleRequests,
      femaleRequests,
    }),
    activeWindowLabel: topBucket,
    repeatWorkerLabel,
    rankLabel: summarizeRanks(rankCounts, topGames, competitive),
    evidenceLines,
    firstSeenAt,
  };
}

export async function buildAndStoreBossPortrait(bossId: string, sampleSize = 50): Promise<BossPortrait | null> {
  const portrait = await buildBossPortrait(bossId, sampleSize);
  if (!portrait) return null;

  const topGamesJson = JSON.stringify(portrait.topGames);
  const evidenceJson = JSON.stringify(portrait.evidenceLines);

  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "BossProfile" (
        "bossId",
        "displayName",
        "spendLevelLabel",
        "styleLabel",
        "preferredCompanionLabel",
        "activeWindowLabel",
        "repeatWorkerLabel",
        "rankLabel",
        "topGames",
        "evidenceLines",
        "totalSpentSnapshot",
        "totalBalanceSnapshot",
        "totalRequestCount",
        "sampledRequestCount",
        "totalEndedOrderCount",
        "sampledEndedOrderCount",
        "averageSpendPerOrder",
        "averageUnitPrice",
        "averageClickCount",
        "firstSeenAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${bossId},
        ${portrait.displayName},
        ${portrait.spendLevelLabel},
        ${portrait.styleLabel},
        ${portrait.preferredCompanionLabel},
        ${portrait.activeWindowLabel},
        ${portrait.repeatWorkerLabel},
        ${portrait.rankLabel},
        ${topGamesJson}::jsonb,
        ${evidenceJson}::jsonb,
        ${portrait.totalSpent},
        ${portrait.totalBalance},
        ${portrait.totalRequestCount},
        ${portrait.sampledRequestCount},
        ${portrait.totalEndedOrderCount},
        ${portrait.sampledEndedOrderCount},
        ${portrait.averageSpendPerOrder},
        ${portrait.averageUnitPrice},
        ${portrait.averageClickCount},
        ${portrait.firstSeenAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("bossId") DO UPDATE SET
        "displayName" = EXCLUDED."displayName",
        "spendLevelLabel" = EXCLUDED."spendLevelLabel",
        "styleLabel" = EXCLUDED."styleLabel",
        "preferredCompanionLabel" = EXCLUDED."preferredCompanionLabel",
        "activeWindowLabel" = EXCLUDED."activeWindowLabel",
        "repeatWorkerLabel" = EXCLUDED."repeatWorkerLabel",
        "rankLabel" = EXCLUDED."rankLabel",
        "topGames" = EXCLUDED."topGames",
        "evidenceLines" = EXCLUDED."evidenceLines",
        "totalSpentSnapshot" = EXCLUDED."totalSpentSnapshot",
        "totalBalanceSnapshot" = EXCLUDED."totalBalanceSnapshot",
        "totalRequestCount" = EXCLUDED."totalRequestCount",
        "sampledRequestCount" = EXCLUDED."sampledRequestCount",
        "totalEndedOrderCount" = EXCLUDED."totalEndedOrderCount",
        "sampledEndedOrderCount" = EXCLUDED."sampledEndedOrderCount",
        "averageSpendPerOrder" = EXCLUDED."averageSpendPerOrder",
        "averageUnitPrice" = EXCLUDED."averageUnitPrice",
        "averageClickCount" = EXCLUDED."averageClickCount",
        "firstSeenAt" = EXCLUDED."firstSeenAt",
        "updatedAt" = CURRENT_TIMESTAMP
    `,
  );

  return portrait;
}

type BossProfileRow = {
  bossId: string;
  displayName: string | null;
  spendLevelLabel: string | null;
  styleLabel: string | null;
  preferredCompanionLabel: string | null;
  activeWindowLabel: string | null;
  repeatWorkerLabel: string | null;
  rankLabel: string | null;
  topGames: unknown;
  evidenceLines: unknown;
  totalSpentSnapshot: Prisma.Decimal | number | null;
  totalBalanceSnapshot: Prisma.Decimal | number | null;
  totalRequestCount: number | null;
  sampledRequestCount: number | null;
  totalEndedOrderCount: number | null;
  sampledEndedOrderCount: number | null;
  averageSpendPerOrder: Prisma.Decimal | number | null;
  averageUnitPrice: Prisma.Decimal | number | null;
  averageClickCount: Prisma.Decimal | number | null;
  firstSeenAt: Date | string | null;
  updatedAt: Date | string | null;
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type BossIdRow = {
  bossId: string;
};

async function listCandidateBossIds(mode: BossPortraitBatchMode): Promise<string[]> {
  const missingFilter =
    mode === 'missing'
      ? Prisma.sql`WHERE bp."bossId" IS NULL`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<BossIdRow[]>(
    Prisma.sql`
      SELECT src."bossId"
      FROM (
        SELECT DISTINCT orl."ownerId" AS "bossId"
        FROM "OrderRequestLog" orl
        UNION
        SELECT DISTINCT o."hostId" AS "bossId"
        FROM "Order" o
      ) src
      LEFT JOIN "BossProfile" bp
        ON bp."bossId" = src."bossId"
      ${missingFilter}
      ORDER BY src."bossId" ASC
    `,
  );

  return rows
    .map((row) => row.bossId?.trim())
    .filter((value): value is string => Boolean(value));
}

async function listExistingBossProfileIds(): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<BossIdRow[]>(
    Prisma.sql`SELECT bp."bossId" FROM "BossProfile" bp`,
  );
  return new Set(
    rows
      .map((row) => row.bossId?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

export async function listStoredBossPortraits(limit = 500): Promise<StoredBossPortrait[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 1000);
  const rows = await prisma.$queryRaw<BossProfileRow[]>(
    Prisma.sql`
      SELECT
        bp."bossId",
        COALESCE(NULLIF(bp."displayName", ''), NULLIF(m."serverDisplayName", ''), bp."bossId") AS "displayName",
        bp."spendLevelLabel",
        bp."styleLabel",
        bp."preferredCompanionLabel",
        bp."activeWindowLabel",
        bp."repeatWorkerLabel",
        bp."rankLabel",
        bp."topGames",
        bp."evidenceLines",
        bp."totalSpentSnapshot",
        bp."totalBalanceSnapshot",
        bp."totalRequestCount",
        bp."sampledRequestCount",
        bp."totalEndedOrderCount",
        bp."sampledEndedOrderCount",
        bp."averageSpendPerOrder",
        bp."averageUnitPrice",
        bp."averageClickCount",
        bp."firstSeenAt",
        bp."updatedAt"
      FROM "BossProfile" bp
      LEFT JOIN "Member" m
        ON m."discordUserId" = bp."bossId"
      ORDER BY bp."updatedAt" DESC, bp."bossId" ASC
      LIMIT ${safeLimit}
    `,
  );

  return rows.map((row) => ({
    bossId: row.bossId,
    displayName: row.displayName?.trim() || row.bossId,
    spendLevelLabel: row.spendLevelLabel?.trim() || '未标注',
    styleLabel: row.styleLabel?.trim() || '未标注',
    preferredCompanionLabel: row.preferredCompanionLabel?.trim() || '未标注',
    activeWindowLabel: row.activeWindowLabel?.trim() || '未标注',
    repeatWorkerLabel: row.repeatWorkerLabel?.trim() || '未标注',
    rankLabel: row.rankLabel?.trim() || '未标注',
    topGames: normalizeStringArray(row.topGames),
    evidenceLines: normalizeStringArray(row.evidenceLines),
    totalSpentSnapshot: toNumber(row.totalSpentSnapshot),
    totalBalanceSnapshot: toNumber(row.totalBalanceSnapshot),
    totalRequestCount: row.totalRequestCount ?? 0,
    sampledRequestCount: row.sampledRequestCount ?? 0,
    totalEndedOrderCount: row.totalEndedOrderCount ?? 0,
    sampledEndedOrderCount: row.sampledEndedOrderCount ?? 0,
    averageSpendPerOrder: toNumber(row.averageSpendPerOrder),
    averageUnitPrice: toNumber(row.averageUnitPrice),
    averageClickCount: toNumber(row.averageClickCount),
    firstSeenAt: normalizeDate(row.firstSeenAt),
    updatedAt: normalizeDate(row.updatedAt),
  }));
}

export async function generateBossPortraitBatch(
  mode: BossPortraitBatchMode,
  sampleSize = 50,
): Promise<BossPortraitBatchResult> {
  const candidateIds = await listCandidateBossIds(mode);
  const existingIds = mode === 'all' ? await listExistingBossProfileIds() : new Set<string>();

  let createdCount = 0;
  let refreshedCount = 0;
  let failedCount = 0;
  const failedIds: string[] = [];

  for (const bossId of candidateIds) {
    try {
      const portrait = await buildAndStoreBossPortrait(bossId, sampleSize);
      if (!portrait) {
        failedCount += 1;
        if (failedIds.length < 20) failedIds.push(bossId);
        continue;
      }

      if (existingIds.has(bossId)) {
        refreshedCount += 1;
      } else {
        createdCount += 1;
      }
    } catch {
      failedCount += 1;
      if (failedIds.length < 20) failedIds.push(bossId);
    }
  }

  return {
    mode,
    candidateCount: candidateIds.length,
    createdCount,
    refreshedCount,
    failedCount,
    failedIds,
  };
}
