import prisma from '../db/prisma.js';

const CACHE_TTL_MS = Number(process.env.ORDER_CHANNEL_BINDING_CACHE_MS ?? 30_000);

export const GENERAL_BROADCAST_CHANNEL_ID = '1421495114928492604';

export const DEFAULT_EXCLUSIVE_OWNER_MAP: Record<string, string> = {
  '1458089933863387207': '1349899133728587786',
  '1458149629223768136': '719621775352266932',
  '1458303076082520215': '539545415687733294',
  '1445226263139582072': '525770714574225408',
  '1473760658402185300': '1406682067852595291',
};

type Snapshot = {
  ownerMap: Record<string, string>;
  channelIds: string[];
  loadedFromDb: boolean;
};

let cache: { expiresAt: number; snapshot: Snapshot } | null = null;

function buildSnapshot(dbMap: Record<string, string>, loadedFromDb: boolean): Snapshot {
  const ownerMap =
    Object.keys(dbMap).length > 0
      ? { ...DEFAULT_EXCLUSIVE_OWNER_MAP, ...dbMap }
      : { ...DEFAULT_EXCLUSIVE_OWNER_MAP };
  const channelIds = Object.keys(ownerMap);
  return { ownerMap, channelIds, loadedFromDb };
}

async function loadFromDatabase(): Promise<Snapshot> {
  try {
    const rows = await prisma.bossChannelBinding.findMany({
      where: { enabled: true },
      select: { channelId: true, ownerId: true },
    });
    const dbMap = Object.fromEntries(
      rows
        .map((row) => [row.channelId.trim(), row.ownerId.trim()] as const)
        .filter(([channelId, ownerId]) => channelId && ownerId),
    );
    return buildSnapshot(dbMap, true);
  } catch (error) {
    console.error('[orderChannelBindingService] load failed, fallback to defaults:', error);
    return buildSnapshot({}, false);
  }
}

export async function getOrderChannelBindingSnapshot(forceReload = false): Promise<Snapshot> {
  const now = Date.now();
  if (!forceReload && cache && cache.expiresAt > now) {
    return cache.snapshot;
  }

  const snapshot = await loadFromDatabase();
  cache = {
    snapshot,
    expiresAt: now + Math.max(5_000, CACHE_TTL_MS),
  };
  return snapshot;
}
