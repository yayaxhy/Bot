import type { GuildMember, Message, Role } from 'discord.js';

export function mentionedRoleIds(message: Message): string[] {
  return [...(message.mentions?.roles?.values() ?? [])].map((r: Role) => r.id);
}

export function intersects(needles: string[] | Set<string>, haystack: string[] | Set<string>): boolean {
  const setA = needles instanceof Set ? needles : new Set(needles);
  for (const v of haystack) if (setA.has(v)) return true;
  return false;
}

export function memberHasAnyRole(member: GuildMember, roleIds: string[] | Set<string>): boolean {
  // Convert IterableIterator<string> -> Set<string>
  const memberRoleIds = new Set(member.roles.cache.keys());
  return intersects(roleIds, memberRoleIds);
}
