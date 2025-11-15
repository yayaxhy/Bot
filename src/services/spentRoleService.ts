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
  const desiredRoles = computeRoleSet(totalSpentNumber);
  if (desiredRoles.length === 0) {
    return;
  }

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
