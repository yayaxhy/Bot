import type { Message } from 'discord.js';
import { mentionedRoleIds, intersects } from './predicates.js';

export type RoleGuardConfig = {
  allowedRoleIds: string[] | Set<string>;
};

export function mentionsAllowedRole(message: Message, cfg: RoleGuardConfig): boolean {
  if (!cfg.allowedRoleIds || (Array.isArray(cfg.allowedRoleIds) && cfg.allowedRoleIds.length === 0)) return false;
  const ids = mentionedRoleIds(message);
  return intersects(cfg.allowedRoleIds, ids);
}
