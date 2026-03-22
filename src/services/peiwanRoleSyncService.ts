import { Client, Events, GuildMember, PartialGuildMember } from 'discord.js';
import { PeiwanGameCode, PeiwanGameTier, PeiwanType } from '@prisma/client';
import prisma from '../db/prisma.js';
import { PEIWAN_ROLE_CATALOG_BY_ID } from '../config/peiwanRoleCatalog.js';

const PEIWAN_ROLE_GUILD_ID =
  process.env.PEIWAN_ROLE_GUILD_ID ?? process.env.SPENT_ROLE_GUILD_ID ?? '';

type RoleSyncMapping = {
  gameCode: PeiwanGameCode;
  tier: PeiwanGameTier;
};

const ROLE_TO_GAME_TIER: Record<string, RoleSyncMapping> = Object.fromEntries(
  [...PEIWAN_ROLE_CATALOG_BY_ID.entries()].map(([roleId, entry]) => [
    roleId,
    { gameCode: entry.gameCode, tier: entry.tier },
  ]),
) as Record<string, RoleSyncMapping>;

const TIER_PRIORITY: Record<PeiwanGameTier, number> = {
  [PeiwanGameTier.ENTERTAINMENT]: 1,
  [PeiwanGameTier.TRAINEE]: 2,
  [PeiwanGameTier.TECH]: 3,
  [PeiwanGameTier.MASTER]: 4,
  [PeiwanGameTier.DEMON_GUARD]: 5,
};

const TYPE_PRIORITY: Record<PeiwanType, number> = {
  [PeiwanType.娱乐陪玩]: 1,
  [PeiwanType.技术陪玩]: 2,
  [PeiwanType.大神陪玩]: 3,
};

type NormalizedProfile = {
  gameCode: PeiwanGameCode;
  tier: PeiwanGameTier;
  sourceRoleId: string;
};

function normalizeProfilesFromMember(member: GuildMember | PartialGuildMember | null | undefined): NormalizedProfile[] {
  if (!member?.roles?.cache) return [];
  const byGame = new Map<PeiwanGameCode, NormalizedProfile>();

  for (const role of member.roles.cache.values()) {
    const mapping = ROLE_TO_GAME_TIER[role.id];
    if (!mapping) continue;

    const current = byGame.get(mapping.gameCode);
    if (!current || TIER_PRIORITY[mapping.tier] > TIER_PRIORITY[current.tier]) {
      byGame.set(mapping.gameCode, {
        gameCode: mapping.gameCode,
        tier: mapping.tier,
        sourceRoleId: role.id,
      });
    }
  }

  return [...byGame.values()].sort((a, b) => a.gameCode.localeCompare(b.gameCode));
}

function derivePeiwanType(profiles: readonly Pick<NormalizedProfile, 'tier'>[]): PeiwanType {
  let derived: PeiwanType = PeiwanType.娱乐陪玩;
  for (const profile of profiles) {
    const nextType =
      profile.tier === PeiwanGameTier.MASTER || profile.tier === PeiwanGameTier.DEMON_GUARD
        ? PeiwanType.大神陪玩
        : profile.tier === PeiwanGameTier.TECH || profile.tier === PeiwanGameTier.TRAINEE
          ? PeiwanType.技术陪玩
          : PeiwanType.娱乐陪玩;
    if (TYPE_PRIORITY[nextType] > TYPE_PRIORITY[derived]) {
      derived = nextType;
    }
  }
  return derived;
}

function profilesEqual(
  existing: readonly { gameCode: PeiwanGameCode; tier: PeiwanGameTier; sourceRoleId: string | null }[],
  next: readonly NormalizedProfile[],
) {
  if (existing.length !== next.length) return false;
  for (let i = 0; i < existing.length; i += 1) {
    const left = existing[i];
    const right = next[i];
    if (
      left.gameCode !== right.gameCode ||
      left.tier !== right.tier ||
      (left.sourceRoleId ?? null) !== right.sourceRoleId
    ) {
      return false;
    }
  }
  return true;
}

type MemberSyncLookup =
  | { ok: true; member: GuildMember | PartialGuildMember | null }
  | { ok: false; reason: 'unknown_member' | 'fetch_failed' };

async function fetchMemberForSync(client: Client, discordUserId: string): Promise<MemberSyncLookup> {
  if (!PEIWAN_ROLE_GUILD_ID) {
    return { ok: false, reason: 'fetch_failed' };
  }
  try {
    const guild = await client.guilds.fetch(PEIWAN_ROLE_GUILD_ID);
    const member = await guild.members.fetch(discordUserId);
    return { ok: true, member };
  } catch (error: any) {
    const code = error?.code;
    if (code === 10007) {
      return { ok: false, reason: 'unknown_member' };
    }
    console.error('[peiwan-role-sync] fetch member failed', { discordUserId, error });
    return { ok: false, reason: 'fetch_failed' };
  }
}

export async function syncPeiwanRolesForDiscordUser(client: Client, discordUserId: string) {
  const peiwan = await prisma.pEIWAN.findUnique({
    where: { discordUserId },
    select: {
      PEIWANID: true,
      discordUserId: true,
      type: true,
      gameProfiles: {
        select: {
          gameCode: true,
          tier: true,
          sourceRoleId: true,
        },
        orderBy: { gameCode: 'asc' },
      },
    },
  });

  if (!peiwan) {
    return { ok: false as const, reason: 'peiwan_not_found' as const };
  }

  const memberResult = await fetchMemberForSync(client, discordUserId);
  if (!memberResult.ok && memberResult.reason === 'fetch_failed') {
    return { ok: false as const, reason: 'member_fetch_failed' as const };
  }

  const member = memberResult.ok ? memberResult.member : null;
  const nextProfiles = normalizeProfilesFromMember(member);
  const nextType = derivePeiwanType(nextProfiles);

  if (profilesEqual(peiwan.gameProfiles, nextProfiles) && peiwan.type === nextType) {
    return {
      ok: true as const,
      changed: false,
      discordUserId,
      peiwanId: peiwan.PEIWANID,
      type: nextType,
      profiles: nextProfiles,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.peiwanGameProfile.deleteMany({
      where: { peiwanId: peiwan.PEIWANID },
    });

    if (nextProfiles.length > 0) {
      await tx.peiwanGameProfile.createMany({
        data: nextProfiles.map((profile) => ({
          peiwanId: peiwan.PEIWANID,
          discordUserId,
          gameCode: profile.gameCode,
          tier: profile.tier,
          source: 'DISCORD_ROLE',
          sourceRoleId: profile.sourceRoleId,
        })),
      });
    }

    await tx.pEIWAN.update({
      where: { PEIWANID: peiwan.PEIWANID },
      data: { type: nextType },
    });
  });

  return {
    ok: true as const,
    changed: true,
    discordUserId,
    peiwanId: peiwan.PEIWANID,
    type: nextType,
    profiles: nextProfiles,
  };
}

async function runStartupSync(client: Client) {
  if (!PEIWAN_ROLE_GUILD_ID) {
    console.warn('[peiwan-role-sync] missing guild id, skip startup sync');
    return;
  }

  const rows = await prisma.pEIWAN.findMany({
    select: { discordUserId: true },
    orderBy: { PEIWANID: 'asc' },
  });

  let changed = 0;
  for (const row of rows) {
    try {
      const result = await syncPeiwanRolesForDiscordUser(client, row.discordUserId);
      if (result.ok && result.changed) {
        changed += 1;
      }
    } catch (error) {
      console.error('[peiwan-role-sync] startup sync failed', { discordUserId: row.discordUserId, error });
    }
  }

  console.log('[peiwan-role-sync] startup sync complete', {
    total: rows.length,
    changed,
  });
}

export function registerPeiwanRoleSync(client: Client) {
  if (!PEIWAN_ROLE_GUILD_ID) {
    console.warn('[peiwan-role-sync] missing guild id, skip sync registration');
    return;
  }

  client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
    if (newMember.guild.id !== PEIWAN_ROLE_GUILD_ID) return;
    syncPeiwanRolesForDiscordUser(client, newMember.id).catch((error) => {
      console.error('[peiwan-role-sync] guild member update sync failed', {
        discordUserId: newMember.id,
        error,
      });
    });
  });

  client.on(Events.GuildMemberRemove, (member) => {
    if (member.guild.id !== PEIWAN_ROLE_GUILD_ID) return;
    syncPeiwanRolesForDiscordUser(client, member.id).catch((error) => {
      console.error('[peiwan-role-sync] guild member remove sync failed', {
        discordUserId: member.id,
        error,
      });
    });
  });

  client.once(Events.ClientReady, () => {
    runStartupSync(client).catch((error) => {
      console.error('[peiwan-role-sync] startup sync error', error);
    });
  });
}
