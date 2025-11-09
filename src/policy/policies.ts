import type { Message } from 'discord.js';
import { mentionsAllowedRole, RoleGuardConfig } from './guards.js';

export type MessagePolicy = (msg: Message) => boolean;

export function makeRoleMentionPolicy(cfg: RoleGuardConfig): MessagePolicy {
  return (msg) => mentionsAllowedRole(msg, cfg);
}

export function and(...policies: MessagePolicy[]): MessagePolicy {
  return (msg) => policies.every(p => p(msg));
}
