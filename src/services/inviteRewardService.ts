import { Client, Events, Guild, GuildMember, Invite } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { recordIndividualTransaction } from './individualTransactionService.js';

const INVITE_REWARD_GUILD_ID =
  process.env.INVITE_REWARD_GUILD_ID
  ?? process.env.SPENT_ROLE_GUILD_ID
  ?? '';

const INVITE_REWARD_AMOUNT = new Prisma.Decimal(2);

type InviteUses = Map<string, number>;
const inviteCache = new Map<string, InviteUses>();

async function refreshInvites(guild: Guild) {
  try {
    const invites = await guild.invites.fetch();
    const uses: InviteUses = new Map();
    for (const inv of invites.values()) {
      uses.set(inv.code, inv.uses ?? 0);
    }
    inviteCache.set(guild.id, uses);
  } catch (err) {
    console.error('[invite-reward] fetch invites failed', err);
  }
}

function detectUsedInvite(
  prev: InviteUses | undefined,
  current: InviteUses,
  currentInvites: Iterable<Invite>
): Invite | null {
  if (!prev) return null;
  for (const inv of currentInvites) {
    const prevUse = prev.get(inv.code) ?? 0;
    const currUse = current.get(inv.code) ?? inv.uses ?? 0;
    if (currUse > prevUse) {
      return inv;
    }
  }
  return null;
}

type RewardResult =
  | { status: 'rewarded'; inviterId: string; balanceAfter: Prisma.Decimal }
  | { status: 'already_joined' | 'joined_no_inviter' | 'already_rewarded' | 'error' };

async function rewardIfEligible(opts: {
  guildId: string;
  inviterId?: string | null;
  inviteeId: string;
  code?: string | null;
}): Promise<RewardResult> {
  const { guildId, inviterId, inviteeId, code } = opts;
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const joined = await tx.guildJoinRecord.findUnique({ where: { userId: inviteeId } });
    if (joined) {
      return { status: 'already_joined' as const };
    }

    // ensure inviter/invitee exist in Member table for FK on InviteLinkUsage
    if (inviterId) {
      await tx.member.upsert({
        where: { discordUserId: inviterId },
        update: {},
        create: { discordUserId: inviterId },
      });
    }
    await tx.member.upsert({
      where: { discordUserId: inviteeId },
      update: {},
      create: { discordUserId: inviteeId },
    });

    await tx.guildJoinRecord.create({
      data: { userId: inviteeId, guildId, firstJoinedAt: now },
    });

    if (!inviterId || inviterId === inviteeId) {
      return { status: 'joined_no_inviter' as const };
    }

    const existingUsage = await tx.inviteLinkUsage.findUnique({ where: { inviteeId } });
    if (existingUsage) {
      return { status: 'already_rewarded' as const };
    }

    const inviterAccount = await tx.member.upsert({
      where: { discordUserId: inviterId },
      create: { discordUserId: inviterId },
      update: {},
      select: { totalBalance: true },
    });

    const balanceBefore = new Prisma.Decimal(inviterAccount.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(INVITE_REWARD_AMOUNT);

    await tx.member.update({
      where: { discordUserId: inviterId },
      data: {
        recharge: { increment: INVITE_REWARD_AMOUNT },
        totalBalance: { increment: INVITE_REWARD_AMOUNT },
      },
    });

    await recordIndividualTransaction(tx, {
      discordId: inviterId,
      thirdPartydiscordId: inviteeId,
      balanceBefore,
      amountChange: INVITE_REWARD_AMOUNT,
      balanceAfter,
      typeOfTransaction: '邀请奖励',
    });

    await tx.inviteLinkUsage.create({
      data: {
        guildId,
        inviteeId,
        inviterId,
        code: code ?? undefined,
        rewardAmount: INVITE_REWARD_AMOUNT,
        rewardedAt: now,
      },
    });

    return { status: 'rewarded' as const, inviterId, balanceAfter };
  }).catch((err) => {
    console.error('[invite-reward] tx failed', { inviteeId, inviterId, code, err });
    return { status: 'error' as const };
  });
}

async function sendInviteDm(inviterId: string, balanceAfter: Prisma.Decimal) {
  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) return;
  try {
    const user = await client.users.fetch(inviterId);
    await user.send(
      `感谢你邀请了新朋友的加入，获得 2 锦鲤币充值，当前余额：${balanceAfter.toString()}`
    );
  } catch (err) {
    console.error('[invite-reward] dm inviter failed', { inviterId, err });
  }
}

async function handleMemberAdd(member: GuildMember) {
  if (!INVITE_REWARD_GUILD_ID) return;
  if (member.user.bot) return;
  if (member.guild.id !== INVITE_REWARD_GUILD_ID) return;

  let usedInvite: Invite | null = null;
  try {
    const prev = inviteCache.get(member.guild.id);
    const invites = await member.guild.invites.fetch();
    const currentUses: InviteUses = new Map();
    for (const inv of invites.values()) {
      currentUses.set(inv.code, inv.uses ?? 0);
    }
    usedInvite = detectUsedInvite(prev, currentUses, invites.values());
    inviteCache.set(member.guild.id, currentUses);
  } catch (err) {
    console.error('[invite-reward] handleMemberAdd fetch invites failed', err);
  }

  const inviterId = usedInvite?.inviter?.id ?? null;
  const code = usedInvite?.code ?? null;
  const result = await rewardIfEligible({
    guildId: member.guild.id,
    inviterId,
    inviteeId: member.id,
    code,
  });

  if (result.status === 'rewarded') {
    console.log('[invite-reward] rewarded inviter', { inviterId, inviteeId: member.id, code });
    sendInviteDm(result.inviterId, result.balanceAfter);
  } else if (result.status !== 'already_joined' && result.status !== 'joined_no_inviter') {
    console.log('[invite-reward] skipped', { inviteeId: member.id, status: result.status, inviterId, code });
  }
}

export function registerInviteReward(client: Client) {
  if (!INVITE_REWARD_GUILD_ID) {
    console.warn('[invite-reward] INVITE_REWARD_GUILD_ID missing, skip registration');
    return;
  }

  client.on(Events.InviteCreate, (invite) => {
    const guild = invite.guild;
    if (guild && 'invites' in guild && guild.id === INVITE_REWARD_GUILD_ID) {
      refreshInvites(guild as Guild).catch((err) => console.error('[invite-reward] inviteCreate refresh failed', err));
    }
  });

  client.on(Events.InviteDelete, (invite) => {
    const guild = invite.guild;
    if (guild && 'invites' in guild && guild.id === INVITE_REWARD_GUILD_ID) {
      refreshInvites(guild as Guild).catch((err) => console.error('[invite-reward] inviteDelete refresh failed', err));
    }
  });

  client.on(Events.GuildMemberAdd, (member) => {
    handleMemberAdd(member).catch((err) => console.error('[invite-reward] handle member add failed', err));
  });

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(INVITE_REWARD_GUILD_ID);
      await refreshInvites(guild);
      console.log('[invite-reward] invite cache initialized');
    } catch (err) {
      console.error('[invite-reward] init failed', err);
    }
  });
}
