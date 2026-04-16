import { PeiwanReviewDisplayMode } from '@prisma/client';
import { Guild } from 'discord.js';

type BossReviewRow = {
  content: string | null;
  displayMode: PeiwanReviewDisplayMode;
  reviewerDiscordId: string;
  reviewerName: string | null;
};

async function loadLiveReviewerNameMap(guild: Guild | null, reviewerIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(reviewerIds.filter(Boolean)));
  if (!guild || uniqueIds.length === 0) {
    return new Map();
  }

  const entries = await Promise.all(
    uniqueIds.map(async (reviewerId) => {
      const member = await guild.members.fetch(reviewerId).catch(() => null);
      const liveName = member?.displayName?.trim() || member?.user.username?.trim() || '';
      return [reviewerId, liveName] as const;
    })
  );

  return new Map(entries.filter((entry) => entry[1]));
}

export async function formatBossReviews(guild: Guild | null, reviewRows: BossReviewRow[]): Promise<string[]> {
  const liveReviewerNameMap = await loadLiveReviewerNameMap(
    guild,
    reviewRows
      .filter((row) => row.displayMode === PeiwanReviewDisplayMode.REALNAME)
      .map((row) => row.reviewerDiscordId)
  );

  return reviewRows.map((row) => {
    const reviewText = String(row.content ?? '').trim();
    if (row.displayMode === PeiwanReviewDisplayMode.ANONYMOUS) {
      return `匿名老板评语：${reviewText}`;
    }

    const reviewerName =
      liveReviewerNameMap.get(row.reviewerDiscordId)?.trim() ||
      (row.reviewerName ?? '').trim();
    if (reviewerName) {
      return `老板${reviewerName}评语：${reviewText}`;
    }
    return `老板评语：${reviewText}`;
  });
}
