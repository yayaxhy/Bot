import prisma from '../db/prisma.js';
import type { Client } from 'discord.js';

type Tier = { threshold: number; roles: string[] };

const SPENT_ROLE_GUILD_ID = process.env.SPENT_ROLE_GUILD_ID ?? '';

const SPENT_ROLE_TIERS: Tier[] = [
  { threshold: 500, roles: ['1430926034873614418', '1431674463401017364'] },
  { threshold: 1500, roles: ['1431678158675116192'] },
  { threshold: 3000, roles: ['1431678273250918451'] },
  { threshold: 5000, roles: ['1431678352338452603'] },
  { threshold: 10000, roles: ['1431678419053056071'] },
  { threshold: 20000, roles: ['1431678531963850804'] },
  { threshold: 50000, roles: ['1431678630265618433'] },
  { threshold: 120000, roles: ['1431678711312416918'] },
  { threshold: 300000, roles: ['1431678784712605856'] },
];

const HEART_ROLE_TIERS: Tier[] = [
  { threshold: 131, roles: ['1430934504096399500', '1432091156199772363'] },
  { threshold: 520, roles: ['1432091440086913025'] },
  { threshold: 999, roles: ['1432091517496983614'] },
  { threshold: 1314, roles: ['1432091592390475917'] },
  { threshold: 3344, roles: ['1432091659264458802'] },
  { threshold: 5210, roles: ['1432091724892737617'] },
  { threshold: 6666, roles: ['1432091787593388214'] },
  { threshold: 9999, roles: ['1432091849190932541'] },
  { threshold: 13140, roles: ['1432091910159335618'] },
  { threshold: 33440, roles: ['1432091982104105130'] },
  { threshold: 52000, roles: ['1432092070243205190'] },
  { threshold: 99999, roles: ['1432092157686190393'] },
  { threshold: 131400, roles: ['1432092226560852009'] },
  { threshold: 334400, roles: ['1432092303777857687'] },
  { threshold: 999999, roles: ['1432092370803097853'] },
];

function computeRoleSet(totalSpent: number): string[] {
  const roleSet = new Set<string>();
  for (const tier of SPENT_ROLE_TIERS) {
    if (totalSpent >= tier.threshold) {
      for (const roleId of tier.roles) {
        roleSet.add(roleId);
      }
    } else {
      break;
    }
  }
  return Array.from(roleSet);
}

function computeHeartRoleSet(heartValue: number): string[] {
  const roleSet = new Set<string>();
  for (const tier of HEART_ROLE_TIERS) {
    if (heartValue >= tier.threshold) {
      for (const roleId of tier.roles) {
        roleSet.add(roleId);
      }
    } else {
      break;
    }
  }
  return Array.from(roleSet);
}

export async function syncSpentRolesForMember(discordId: string) {
  if (!SPENT_ROLE_GUILD_ID) {
    return;
  }

  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) {
    console.warn('[spent-role] no discord client');
    return;
  }

  const memberRecord = await prisma.member.findUnique({
    where: { discordUserId: discordId },
    select: { totalSpent: true, VIPRoleOptOut: true },
  });
  if (!memberRecord || memberRecord.VIPRoleOptOut) {
    return;
  }

  const totalSpentNumber = Number(memberRecord.totalSpent?.toString?.() ?? memberRecord.totalSpent ?? 0);
  const spendRoles = computeRoleSet(totalSpentNumber);

  const [heartSent, heartReceived] = await Promise.all([
    prisma.heartCounter.aggregate({
      _sum: { total: true },
      where: { fromMemberId: discordId },
    }),
    prisma.heartCounter.aggregate({
      _sum: { total: true },
      where: { toMemberId: discordId },
    }),
  ]);

  const sentTotal = Number(heartSent._sum?.total ?? 0);
  const receivedTotal = Number(heartReceived._sum?.total ?? 0);
  const heartValue = Math.max(sentTotal, receivedTotal);
  const heartRoles = computeHeartRoleSet(heartValue);

  const desiredRoles = Array.from(new Set([...spendRoles, ...heartRoles]));
  if (desiredRoles.length === 0) return;

  try {
    const guild = await client.guilds.fetch(SPENT_ROLE_GUILD_ID);
    const member = await guild.members.fetch(discordId);

    const missingRoles = desiredRoles.filter((roleId) => !member.roles.cache.has(roleId));
    if (missingRoles.length === 0) {
      return;
    }

    await member.roles.add(missingRoles);
    console.log('[spent-role] assigned roles', { discordId, missingRoles });
  } catch (err) {
    console.error('[spent-role] failed to assign roles', { discordId, err });
  }
}
