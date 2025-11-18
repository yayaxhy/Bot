import { Client, Events, GuildMember, PartialGuildMember } from 'discord.js';
import prisma from '../db/prisma.js';

const TECH_ROLE_ID = process.env.TECH_ROLE_ID ?? '1430923746830581841';
const TECH_ROLE_GUILD_ID = process.env.SPENT_ROLE_GUILD_ID ?? '';

async function updateTechTag(discordId: string, hasRole: boolean) {
  try {
    const result = await prisma.pEIWAN.updateMany({
      where: { discordUserId: discordId },
      data: { techTag: hasRole },
    });
    if (result.count > 0) {
      console.log('[tech-tag] updated', { discordId, hasRole });
    }
  } catch (err) {
    console.error('[tech-tag] failed to update', { discordId, hasRole, err });
  }
}

function memberHasTechRole(member?: GuildMember | PartialGuildMember | null) {
  if (!member) return undefined;
  const roles = 'roles' in member ? member.roles : undefined;
  if (!roles) return undefined;
  return roles.cache.has(TECH_ROLE_ID);
}

async function runInitialSync(client: Client) {
  if (!TECH_ROLE_GUILD_ID || !TECH_ROLE_ID) return;
  try {
    const guild = await client.guilds.fetch(TECH_ROLE_GUILD_ID);
    const members = await guild.members.fetch();
    const idsWithRole: string[] = [];
    for (const member of members.values()) {
      if (member.roles.cache.has(TECH_ROLE_ID)) {
        idsWithRole.push(member.id);
      }
    }

    await prisma.pEIWAN.updateMany({
      where: { techTag: true },
      data: { techTag: false },
    });

    if (idsWithRole.length) {
      await prisma.pEIWAN.updateMany({
        where: { discordUserId: { in: idsWithRole } },
        data: { techTag: true },
      });
    }
    console.log('[tech-tag] initial sync complete', { count: idsWithRole.length });
  } catch (err) {
    console.error('[tech-tag] initial sync failed', err);
  }
}

export function registerTechTagSync(client: Client) {
  if (!TECH_ROLE_GUILD_ID || !TECH_ROLE_ID) {
    console.warn('[tech-tag] missing guild or role id, skip sync');
    return;
  }

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id !== TECH_ROLE_GUILD_ID) return;
    updateTechTag(member.id, member.roles.cache.has(TECH_ROLE_ID));
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (newMember.guild.id !== TECH_ROLE_GUILD_ID) return;
    const prev = memberHasTechRole(oldMember ?? null);
    const curr = memberHasTechRole(newMember);
    if (prev === curr || curr === undefined) {
      return;
    }
    updateTechTag(newMember.id, curr);
  });

  client.once(Events.ClientReady, () => {
    runInitialSync(client).catch((err) => console.error('[tech-tag] initial sync error', err));
  });
}
