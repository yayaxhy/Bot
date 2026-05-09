import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  InteractionReplyOptions,
  userMention,
  type MessageCreateOptions,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { AuditionInviteStatus, MemberStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { MIN } from '../lib/time.js';
import { round2 } from '../lib/money.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import {
  applyJinleeWalletDeltaTx,
  ensureJinleeIdentityForDiscordTx,
  getJinleeWalletSnapshotTx,
  lockJinleeUserForUpdateTx,
} from './jinleeAccountService.js';
import { recordIndividualTransaction } from './individualTransactionService.js';
import { getActiveCommissionBoost } from './buffService.js';
import { getAutoCommissionBoost } from './autoCommissionBuffService.js';
import { resolveOrderRequestOwnerId } from './orderRequestLogService.js';
import { ORDER_REQUEST_CLOSE_MS } from './orderInteractionManager.js';
import { scheduleSpentRoleSync } from './spentRoleService.js';

const AUDITION_CATEGORY_ID = process.env.AUDITION_CATEGORY_ID ?? '1421488476913795072';
const AUDITION_PRICE = new Prisma.Decimal(process.env.AUDITION_PRICE ?? '5');
const AUDITION_INVITE_EXPIRE_MS = Math.max(
  MIN,
  Number.parseInt(process.env.AUDITION_INVITE_EXPIRE_MS ?? '', 10) || 2 * MIN,
);
const AUDITION_EMPTY_DELETE_MS = Math.max(
  MIN,
  Number.parseInt(process.env.AUDITION_EMPTY_DELETE_MS ?? '', 10) || 10 * MIN,
);
const ACTIVE_INVITE_STATUSES = [AuditionInviteStatus.PENDING, AuditionInviteStatus.ACCEPTED] as const;
const INSUFFICIENT_BALANCE_ERROR = '余额不足，无法发起真人试音。';
const INSUFFICIENT_RESERVED_ERROR = '可用余额不足（存在进行中的订单已计费预留）。';

const roomTimers = new Map<string, NodeJS.Timeout>();
const inviteTimers = new Map<string, NodeJS.Timeout>();
const settlingInviteIds = new Set<string>();
const expiringInviteIds = new Set<string>();
const deletingRoomBossIds = new Set<string>();

const hasSend = (channel: unknown): channel is { send: Function } =>
  !!channel && typeof (channel as any).send === 'function';
const isMissingAccessError = (err: any) =>
  err?.code === 50001 || err?.code === 50007 || (typeof err?.message === 'string' && err.message.includes('Missing Access'));

function buildChannelUrl(guildId: string, channelId: string) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function buildStateRow(label: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`audition:state:${label}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  ];
}

function buildAuditionNoticeEmbed(title: string, description: string, color = 0xf5a623) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

function buildPeiwanIdentityText(
  workerId: string,
  peiwanId: number | null | undefined,
  workerDisplayName?: string | null,
) {
  const displayName = String(workerDisplayName ?? '').trim();
  const pieces: string[] = [];
  if (peiwanId != null) {
    pieces.push(`陪玩${peiwanId}`);
  } else if (displayName) {
    pieces.push('陪玩');
  }
  if (displayName) {
    pieces.push(displayName);
  }
  pieces.push(userMention(workerId));
  return pieces.join(' ');
}

function buildInviteSentEmbed(
  workerId: string,
  peiwanId: number | null | undefined,
  workerDisplayName?: string | null,
) {
  const peiwanText = buildPeiwanIdentityText(workerId, peiwanId, workerDisplayName);
  return buildAuditionNoticeEmbed(
    '真人试音邀请已发送',
    `已向${peiwanText}发送真人试音邀请，等待对方确认。该邀请两分钟内有效。`,
  );
}

function buildDuplicateInviteNotice(channelUrl?: string | null) {
  const normalized = String(channelUrl ?? '').trim();
  return normalized
    ? `该陪玩已有待处理的真人试音邀请，请等待对方处理。当前试音频道：${normalized}`
    : '该陪玩已有待处理的真人试音邀请，请等待对方处理。';
}

function buildWorkerDmPayload(inviteId: string, bossId: string): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setColor(0xf5a623)
    .setTitle('真人试音邀请')
    .setDescription(
      [
        `${userMention(bossId)} 老板邀请你进行真人试音`,
        '同意后系统会立即为老板创建专属试音频道',
        `老板将支付 ${AUDITION_PRICE.toString()} 锦鲤币，您的试音收入按当前抽成结算`,
        '该邀请两分钟内有效',
      ].join('\n'),
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`audition:accept:${inviteId}`)
      .setLabel('接受')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`audition:decline:${inviteId}`)
      .setLabel('拒绝')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

function buildBossCancelRow(inviteId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`audition:cancel:${inviteId}`)
        .setLabel('取消真人试音')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildBossRejectNotice(workerId: string, peiwanId: number | null | undefined) {
  const peiwanText = peiwanId != null ? `陪玩 ${peiwanId}` : '该陪玩';
  return `<@${workerId}> ${peiwanText} 正在忙，拒绝了您的真人试音邀请`;
}

function buildBossPendingExpireNotice(workerId: string, peiwanId: number | null | undefined) {
  const peiwanText = peiwanId != null ? `陪玩 ${peiwanId}` : '该陪玩';
  return `<@${workerId}> ${peiwanText} 未在两分钟内接受真人试音邀请。您可以选择点击该陪玩名片下方的语音条进行试音。`;
}

function buildBossAcceptedExpireNotice(workerId: string, peiwanId: number | null | undefined) {
  const peiwanText = peiwanId != null ? `陪玩 ${peiwanId}` : '该陪玩';
  return `${peiwanText} 与您未能在两分钟内同时到达试音厅，本次真人试音邀请已失效。您可以选择点击该陪玩名片下方的语音条进行试音。`;
}

function buildBossInsufficientBalanceNotice(workerId: string, peiwanId: number | null | undefined) {
  const peiwanText = peiwanId != null ? `陪玩 ${peiwanId}` : '该陪玩';
  return `${peiwanText} 已进入试音厅，但您的可用余额不足，真人试音未能生效。请充值后重新邀请 ${userMention(workerId)}。`;
}

function buildBossAcceptedRoomEmbed(
  workerId: string,
  peiwanId: number | null | undefined,
  workerDisplayName: string | null | undefined,
  channelUrl: string,
) {
  const peiwanText = buildPeiwanIdentityText(workerId, peiwanId, workerDisplayName);
  return buildAuditionNoticeEmbed(
    '真人试音邀请已接受',
    `${peiwanText} 已经接受试音请求，您可以前往您的专属试音频道进行试音：\n${channelUrl}`,
    0x57f287,
  );
}

function buildWorkerAcceptedRoomEmbed(channelUrl: string, bossId: string) {
  return buildAuditionNoticeEmbed(
    '请立刻前往试音频道',
    `请立刻前往试音频道进行试音，请不要让老板等待，如果突发状况请立刻联系老板 ${userMention(bossId)}\n频道链接：${channelUrl}`,
    0x57f287,
  );
}

function buildBossSuccessEmbed(
  workerId: string,
  peiwanId: number | null | undefined,
  workerDisplayName: string | null | undefined,
) {
  const peiwanText = buildPeiwanIdentityText(workerId, peiwanId, workerDisplayName);
  return buildAuditionNoticeEmbed(
    '真人试音已完成',
    `${peiwanText} 已进入试音厅，本次真人试音已扣除 ${AUDITION_PRICE.toString()} 锦鲤币。`,
    0x57f287,
  );
}

function buildWorkerSuccessEmbed(netAmount: Prisma.Decimal) {
  return buildAuditionNoticeEmbed(
    '您已经进入试音频道',
    `您已经进入试音频道，本次真人试音收入 ${netAmount.toFixed(2)} 锦鲤币。`,
    0x57f287,
  );
}

function buildWorkerCanceledNotice(reason: string) {
  return `本次真人试音邀请已失效：${reason}`;
}

function sanitizeBossLabel(raw: string) {
  const normalized = raw
    .replace(/[\\/:*?"<>|#\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = normalized.slice(0, 32) || '老板';
  return trimmed.endsWith('老板') ? trimmed : `${trimmed}老板`;
}

async function resolveBossRoomLabel(
  client: Client,
  bossId: string,
  preferredDisplayName?: string | null,
) {
  const preferred = String(preferredDisplayName ?? '').trim();
  if (preferred) return preferred;
  const user = await client.users.fetch(bossId).catch(() => null);
  const fallback = String(user?.displayName ?? user?.username ?? '').trim();
  return fallback || '老板';
}

async function resolvePeiwanIdentity(
  client: Client,
  workerId: string,
  fallbackPeiwanId?: number | null,
  preferredDisplayName?: string | null,
) {
  let peiwanId = fallbackPeiwanId ?? null;
  let workerDisplayName = String(preferredDisplayName ?? '').trim();

  if (peiwanId == null || !workerDisplayName) {
    const peiwan = await prisma.pEIWAN.findUnique({
      where: { discordUserId: workerId },
      select: { PEIWANID: true, serverDisplayName: true },
    }).catch(() => null);
    if (peiwanId == null) {
      peiwanId = peiwan?.PEIWANID ?? null;
    }
    if (!workerDisplayName) {
      workerDisplayName = String(peiwan?.serverDisplayName ?? '').trim();
    }
  }

  if (!workerDisplayName) {
    const user = await client.users.fetch(workerId).catch(() => null);
    workerDisplayName = String(user?.displayName ?? user?.username ?? '').trim();
  }

  return {
    peiwanId,
    workerDisplayName: workerDisplayName || null,
  };
}

function parseAuditionRequestCustomId(customId: string) {
  const parts = customId.split(':');
  if (parts.length < 5) return null;
  const [, action, orderRequestId, workerId, peiwanIdRaw] = parts;
  if (action !== 'request' || !orderRequestId || !workerId) return null;
  const peiwanId = Number(peiwanIdRaw);
  return {
    orderRequestId,
    workerId,
    peiwanId: Number.isFinite(peiwanId) ? peiwanId : null,
  };
}

function parseAuditionInviteCustomId(customId: string, action: 'accept' | 'decline' | 'cancel') {
  const parts = customId.split(':');
  if (parts.length < 3) return null;
  if (parts[1] !== action) return null;
  return parts[2] || null;
}

function isAuditionRequestExpired(createdAtMs: number | null | undefined) {
  if (!Number.isFinite(createdAtMs)) return false;
  return Date.now() - Number(createdAtMs) > ORDER_REQUEST_CLOSE_MS;
}

export function buildAuditionRequestButtonRow(orderRequestId: string, workerId: string, peiwanId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`audition:request:${orderRequestId}:${workerId}:${peiwanId}`)
      .setLabel('申请真人试音(付费5锦鲤币)')
      .setStyle(ButtonStyle.Primary),
  );
}

async function safeFetchMessageChannel(client: Client, channelId: string | null | undefined) {
  const normalized = String(channelId ?? '').trim();
  if (!normalized) return null;
  try {
    return await client.channels.fetch(normalized);
  } catch (err) {
    if (isMissingAccessError(err)) return null;
    console.error('[audition] fetch channel failed:', err);
    return null;
  }
}

async function notifyBoss(
  client: Client,
  bossId: string,
  fallbackChannelId: string | null | undefined,
  content: string,
) {
  return notifyBossWithPayload(client, bossId, fallbackChannelId, { content });
}

async function notifyBossWithPayload(
  client: Client,
  bossId: string,
  fallbackChannelId: string | null | undefined,
  payload: MessageCreateOptions,
) {
  try {
    const user = await client.users.fetch(bossId);
    await user.send(payload);
    return;
  } catch (err: any) {
    if (err?.code !== 50007) {
      console.error('[audition] notify boss dm failed:', err);
      return;
    }
  }

  const fallbackChannel = await safeFetchMessageChannel(client, fallbackChannelId);
  if (fallbackChannel && fallbackChannel.isTextBased() && hasSend(fallbackChannel)) {
    try {
      const content = payload.content ? `<@${bossId}> ${payload.content}` : `<@${bossId}>`;
      await fallbackChannel.send({
        ...payload,
        content,
        allowedMentions: { parse: ['users'] },
      });
    } catch (err) {
      console.error('[audition] notify boss fallback failed:', err);
    }
  }
}

async function notifyWorker(client: Client, workerId: string, content: string) {
  return notifyWorkerWithPayload(client, workerId, { content });
}

async function notifyWorkerWithPayload(
  client: Client,
  workerId: string,
  payload: MessageCreateOptions,
) {
  try {
    const user = await client.users.fetch(workerId);
    await user.send(payload);
  } catch (err) {
    console.error('[audition] notify worker failed:', err);
  }
}

async function updateInviteMessageState(
  client: Client,
  invite: {
    workerPromptChannelId: string | null;
    workerPromptMessageId: string | null;
  },
  label: string,
) {
  if (!invite.workerPromptChannelId || !invite.workerPromptMessageId) return;
  const channel = await safeFetchMessageChannel(client, invite.workerPromptChannelId);
  if (!channel || !('messages' in channel)) return;
  try {
    const msg = await (channel as any).messages.fetch(invite.workerPromptMessageId);
    if (!msg?.editable) return;
    await msg.edit({ components: buildStateRow(label) });
  } catch (err) {
    console.error('[audition] update invite message state failed:', err);
  }
}

async function ensureAuditionRoom(
  client: Client,
  bossId: string,
  bossDisplayName: string,
) {
  const channelName = `${sanitizeBossLabel(bossDisplayName)}的试音厅`;
  const existing = await prisma.auditionRoom.findUnique({ where: { bossId } });
  if (existing) {
    const channel = await client.channels.fetch(existing.channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildVoice) {
      if (channel.name !== channelName) {
        await channel.setName(channelName).catch(() => null);
        await prisma.auditionRoom.update({
          where: { bossId },
          data: { channelName },
        }).catch(() => null);
      }
      return { room: existing, created: false };
    }
    await prisma.auditionRoom.delete({ where: { bossId } }).catch(() => null);
  }

  const category = await client.channels.fetch(AUDITION_CATEGORY_ID);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error('AUDITION_CATEGORY_NOT_FOUND');
  }

  await prisma.member.upsert({
    where: { discordUserId: bossId },
    create: { discordUserId: bossId },
    update: {},
  });
  const channel = await category.guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: category.id,
  });

  const now = new Date();

  try {
    const room = await prisma.auditionRoom.create({
      data: {
        bossId,
        guildId: category.guild.id,
        categoryId: category.id,
        channelId: channel.id,
        channelName,
        emptySince: now,
      },
    });
    scheduleRoomDeletion(client, room.bossId, now);
    return { room, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const room = await prisma.auditionRoom.findUnique({ where: { bossId } });
      if (room) {
        await channel.delete().catch(() => null);
        return { room, created: false };
      }
    }
    await channel.delete().catch(() => null);
    throw err;
  }
}

function cancelInviteTimer(inviteId: string) {
  const timer = inviteTimers.get(inviteId);
  if (timer) clearTimeout(timer);
  inviteTimers.delete(inviteId);
}

function cancelRoomTimer(bossId: string) {
  const timer = roomTimers.get(bossId);
  if (timer) clearTimeout(timer);
  roomTimers.delete(bossId);
}

function scheduleInviteExpiry(client: Client, inviteId: string, expiresAt: Date) {
  cancelInviteTimer(inviteId);
  const delay = expiresAt.getTime() - Date.now();
  if (delay <= 0) {
    void expireAuditionInvite(client, inviteId);
    return;
  }
  inviteTimers.set(
    inviteId,
    setTimeout(() => {
      expireAuditionInvite(client, inviteId).catch((err) =>
        console.error('[audition] expire invite failed:', err),
      );
    }, delay),
  );
}

function scheduleRoomDeletion(client: Client, bossId: string, emptySince: Date) {
  cancelRoomTimer(bossId);
  const delay = emptySince.getTime() + AUDITION_EMPTY_DELETE_MS - Date.now();
  if (delay <= 0) {
    void deleteAuditionRoom(client, bossId, 'empty_timeout');
    return;
  }
  roomTimers.set(
    bossId,
    setTimeout(() => {
      deleteAuditionRoom(client, bossId, 'empty_timeout').catch((err) =>
        console.error('[audition] delete room failed:', err),
      );
    }, delay),
  );
}

async function expireAuditionInvite(client: Client, inviteId: string) {
  if (expiringInviteIds.has(inviteId)) return;
  expiringInviteIds.add(inviteId);
  try {
    const now = new Date();
    const invite = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "AuditionInvite" WHERE "id" = ${inviteId} FOR UPDATE`;
      const current = await tx.auditionInvite.findUnique({ where: { id: inviteId } });
      if (!current) return null;
      if (!ACTIVE_INVITE_STATUSES.includes(current.status as (typeof ACTIVE_INVITE_STATUSES)[number])) {
        return current;
      }
      if (current.expiresAt.getTime() > now.getTime()) return current;
      return tx.auditionInvite.update({
        where: { id: inviteId },
        data: {
          status: AuditionInviteStatus.EXPIRED,
          canceledAt: now,
          failureReason: 'invite_expired',
        },
      });
    });

    cancelInviteTimer(inviteId);
    if (!invite) return;
    if (invite.status !== AuditionInviteStatus.EXPIRED) return;

    await updateInviteMessageState(client, invite, '邀请已过期');
    const hasAssignedRoom = !!String(invite.roomChannelId ?? '').trim() || !!invite.acceptedAt;
    await notifyBoss(
      client,
      invite.bossId,
      invite.bossContactChannelId,
      hasAssignedRoom
        ? buildBossAcceptedExpireNotice(invite.workerId, invite.peiwanId)
        : buildBossPendingExpireNotice(invite.workerId, invite.peiwanId),
    );
  } finally {
    expiringInviteIds.delete(inviteId);
  }
}

async function deleteAuditionRoom(client: Client, bossId: string, reason: string) {
  if (deletingRoomBossIds.has(bossId)) return;
  deletingRoomBossIds.add(bossId);
  try {
    const room = await prisma.auditionRoom.findUnique({ where: { bossId } });
    if (!room) return;

    cancelRoomTimer(bossId);

    const activeInvites = await prisma.auditionInvite.findMany({
      where: {
        roomChannelId: room.channelId,
        status: { in: [...ACTIVE_INVITE_STATUSES] },
      },
      select: {
        id: true,
        workerPromptChannelId: true,
        workerPromptMessageId: true,
      },
    });

    const channel = await client.channels.fetch(room.channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildVoice) {
      await channel.delete().catch((err) => console.error('[audition] delete voice channel failed:', err));
    }

    await prisma.$transaction(async (tx) => {
      await tx.auditionInvite.updateMany({
        where: {
          roomChannelId: room.channelId,
          status: { in: [...ACTIVE_INVITE_STATUSES] },
        },
        data: {
          status: AuditionInviteStatus.CANCELED,
          canceledAt: new Date(),
          failureReason: reason,
        },
      });
      await tx.auditionRoom.delete({ where: { bossId } });
    });

    for (const invite of activeInvites) {
      cancelInviteTimer(invite.id);
      await updateInviteMessageState(client, invite, '试音厅已关闭');
    }
  } finally {
    deletingRoomBossIds.delete(bossId);
  }
}

async function syncRoomStateFromChannel(
  client: Client,
  room: {
    bossId: string;
    channelId: string;
    emptySince: Date | null;
  },
  channel: VoiceChannel,
) {
  const humanCount = channel.members.filter((member) => !member.user.bot).size;
  const isEmpty = humanCount === 0;
  const now = new Date();
  let nextEmptySince = room.emptySince;

  if (isEmpty && !room.emptySince) {
    const updated = await prisma.auditionRoom.update({
      where: { bossId: room.bossId },
      data: { emptySince: now },
    });
    nextEmptySince = updated.emptySince;
  } else if (!isEmpty && room.emptySince) {
    await prisma.auditionRoom.update({
      where: { bossId: room.bossId },
      data: { emptySince: null },
    });
    nextEmptySince = null;
  }

  if (nextEmptySince) {
    scheduleRoomDeletion(client, room.bossId, nextEmptySince);
  } else {
    cancelRoomTimer(room.bossId);
  }
}

function resolveInsufficientReason(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  if (message.includes(INSUFFICIENT_RESERVED_ERROR)) return INSUFFICIENT_RESERVED_ERROR;
  if (message.includes(INSUFFICIENT_BALANCE_ERROR)) return INSUFFICIENT_BALANCE_ERROR;
  return null;
}

async function settleAuditionInvite(client: Client, inviteId: string) {
  if (settlingInviteIds.has(inviteId)) return;
  settlingInviteIds.add(inviteId);
  try {
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "AuditionInvite" WHERE "id" = ${inviteId} FOR UPDATE`;
      const invite = await tx.auditionInvite.findUnique({
        where: { id: inviteId },
        select: {
          id: true,
          bossId: true,
          workerId: true,
          peiwanId: true,
          bossContactChannelId: true,
          workerPromptChannelId: true,
          workerPromptMessageId: true,
          status: true,
          expiresAt: true,
        },
      });
      if (!invite) return { outcome: 'missing' as const };
      if (!ACTIVE_INVITE_STATUSES.includes(invite.status as (typeof ACTIVE_INVITE_STATUSES)[number])) {
        return { outcome: 'inactive' as const, invite };
      }
      if (invite.expiresAt.getTime() <= now.getTime()) {
        const expiredInvite = await tx.auditionInvite.update({
          where: { id: inviteId },
          data: {
            status: AuditionInviteStatus.EXPIRED,
            canceledAt: now,
            failureReason: 'invite_expired',
          },
        });
        return { outcome: 'expired' as const, invite: expiredInvite };
      }

      const gross = round2(AUDITION_PRICE);
      const bossIdentity = await ensureJinleeIdentityForDiscordTx(tx, invite.bossId);
      const workerIdentity = await ensureJinleeIdentityForDiscordTx(tx, invite.workerId);

      await lockJinleeUserForUpdateTx(tx, bossIdentity.jinleeId);
      await lockJinleeUserForUpdateTx(tx, workerIdentity.jinleeId);

      const bossWallet = await getJinleeWalletSnapshotTx(tx, bossIdentity);
      const runningReserved = await tx.order.aggregate({
        _sum: { chargedGross: true },
        where: { hostId: invite.bossId, status: 'RUNNING' as any },
      });
      const reservedForRunningOrders = new Prisma.Decimal(runningReserved._sum?.chargedGross ?? 0);
      let availableForAudition = bossWallet.totalBalance.sub(reservedForRunningOrders);
      if (availableForAudition.lt(0)) availableForAudition = new Prisma.Decimal(0);
      if (availableForAudition.lt(gross)) {
        if (bossWallet.totalBalance.lt(gross)) throw new Error(INSUFFICIENT_BALANCE_ERROR);
        if (reservedForRunningOrders.gt(0)) throw new Error(INSUFFICIENT_RESERVED_ERROR);
        throw new Error(INSUFFICIENT_BALANCE_ERROR);
      }

      const bossSplit = splitIncomeRecharge(bossWallet.income, bossWallet.recharge, gross);

      const workerMember = await tx.member.findUnique({
        where: { discordUserId: invite.workerId },
        select: { commissionRate: true, totalBalance: true },
      });
      if (!workerMember) throw new Error('WORKER_NOT_FOUND');

      let payoutShare = new Prisma.Decimal(workerMember.commissionRate ?? 0.75);
      const manualBoost = await getActiveCommissionBoost(tx, invite.workerId);
      const autoBoost = await getAutoCommissionBoost(tx, invite.workerId, payoutShare);
      payoutShare = payoutShare.add(manualBoost).add(autoBoost);
      if (payoutShare.gt(1)) payoutShare = new Prisma.Decimal(1);

      const netAmount = round2(gross.mul(payoutShare));
      const feeAmount = round2(gross.sub(netAmount));

      const bossWalletAfter = await applyJinleeWalletDeltaTx(tx, {
        jinleeId: bossIdentity.jinleeId,
        discordUserId: bossIdentity.discordUserId,
        incomeDelta: bossSplit.fromIncome.neg(),
        rechargeDelta: bossSplit.fromRecharge.neg(),
        totalBalanceDelta: gross.neg(),
        totalSpentDelta: gross,
      });

      const bossIndividualTx = await recordIndividualTransaction(tx, {
        discordId: bossIdentity.discordUserId,
        jinleeId: bossIdentity.jinleeId,
        thirdPartydiscordId: invite.workerId,
        balanceBefore: bossWallet.totalBalance,
        amountChange: gross,
        balanceAfter: bossWalletAfter.totalBalance,
        typeOfTransaction: '试音花费',
      });

      const workerWalletBefore = await getJinleeWalletSnapshotTx(tx, workerIdentity);
      const workerWalletAfter = await applyJinleeWalletDeltaTx(tx, {
        jinleeId: workerIdentity.jinleeId,
        discordUserId: workerIdentity.discordUserId,
        incomeDelta: netAmount,
        totalBalanceDelta: netAmount,
        offsetNegativeRechargeWithIncome: true,
      });

      await tx.pEIWAN.update({
        where: { discordUserId: invite.workerId },
        data: {
          balance: workerWalletAfter.totalBalance,
          totalEarn: { increment: gross },
        },
      }).catch(() => null);

      const workerIndividualTx = await recordIndividualTransaction(tx, {
        discordId: workerIdentity.discordUserId,
        jinleeId: workerIdentity.jinleeId,
        thirdPartydiscordId: invite.bossId,
        balanceBefore: workerWalletBefore.totalBalance,
        amountChange: netAmount,
        balanceAfter: workerWalletAfter.totalBalance,
        typeOfTransaction: '试音收入',
      });

      const transactionRow = await tx.transaction.create({
        data: {
          fromId: bossIdentity.discordUserId ?? null,
          toId: invite.workerId,
          fromJinleeId: bossIdentity.jinleeId,
          toJinleeId: workerIdentity.jinleeId,
          amount: gross,
          feeAmount,
          netAmount,
        },
      });

      await tx.commission.create({
        data: {
          transactionId: transactionRow.Transid,
          orderID: transactionRow.orderID,
          fromId: bossIdentity.discordUserId ?? null,
          toId: invite.workerId,
          fromJinleeId: bossIdentity.jinleeId,
          toJinleeId: workerIdentity.jinleeId,
          feeAmount,
        },
      });

      await tx.giftAudit.create({
        data: {
          paymentTransactionId: transactionRow.Transid,
          individualTransactionId: bossIndividualTx.transactionId,
          orderId: transactionRow.orderID,
          giftName: '真人试音',
          quantity: new Prisma.Decimal(1),
          unitPrice: gross,
          gross,
          payable: gross,
          pointsEarned: new Prisma.Decimal(0),
          feeAmount,
          netAmount,
          receiverRate: payoutShare,
          heartGain: 0,
          giverId: bossIdentity.discordUserId ?? invite.bossId,
          receiverId: invite.workerId,
          giverFromIncome: bossSplit.fromIncome,
          giverFromRecharge: bossSplit.fromRecharge,
          spendBonusExtra: new Prisma.Decimal(0),
          spendRemainingBefore: new Prisma.Decimal(0),
          flowBonusExtra: new Prisma.Decimal(0),
          flowRemainingBefore: new Prisma.Decimal(0),
          voucherIds: [],
          couponIds: [],
          bossReferralInviterId: null,
          bossReferralAmount: null,
          workerReferralInviterId: null,
          workerReferralAmount: null,
        },
      });

      const updatedInvite = await tx.auditionInvite.update({
        where: { id: inviteId },
        data: {
          status: AuditionInviteStatus.FULFILLED,
          acceptedAt: now,
          joinedAt: now,
          chargedAt: now,
          fulfilledAt: now,
          transactionId: transactionRow.Transid,
          grossAmount: gross,
          feeAmount,
          netAmount,
        },
      });

      return {
        outcome: 'fulfilled' as const,
        invite: updatedInvite,
        bossIndividualTxId: bossIndividualTx.transactionId,
        workerIndividualTxId: workerIndividualTx.transactionId,
        netAmount,
      };
    }).catch(async (err) => {
      const reason = resolveInsufficientReason(err instanceof Error ? err.message : err);
      if (!reason) throw err;
      const canceledInvite = await prisma.auditionInvite.update({
        where: { id: inviteId },
        data: {
          status: AuditionInviteStatus.CANCELED,
          canceledAt: new Date(),
          failureReason: reason,
        },
      });
      return { outcome: 'insufficient' as const, invite: canceledInvite };
    });

    cancelInviteTimer(inviteId);

    if (result.outcome === 'expired') {
      await updateInviteMessageState(client, result.invite, '邀请已过期');
      await notifyBoss(
        client,
        result.invite.bossId,
        result.invite.bossContactChannelId,
        buildBossAcceptedExpireNotice(result.invite.workerId, result.invite.peiwanId),
      );
      return;
    }

    if (result.outcome === 'insufficient') {
      await updateInviteMessageState(client, result.invite, '余额不足，邀请失效');
      await notifyBoss(
        client,
        result.invite.bossId,
        result.invite.bossContactChannelId,
        buildBossInsufficientBalanceNotice(result.invite.workerId, result.invite.peiwanId),
      );
      await notifyWorker(client, result.invite.workerId, buildWorkerCanceledNotice('老板当前余额不足，本次真人试音未生效。'));
      return;
    }

    if (result.outcome !== 'fulfilled') return;

    const workerIdentity = await resolvePeiwanIdentity(
      client,
      result.invite.workerId,
      result.invite.peiwanId,
    );
    await updateInviteMessageState(client, result.invite, '真人试音已完成');
    await notifyBossWithPayload(
      client,
      result.invite.bossId,
      result.invite.bossContactChannelId,
      {
        embeds: [
          buildBossSuccessEmbed(
            result.invite.workerId,
            workerIdentity.peiwanId,
            workerIdentity.workerDisplayName,
          ),
        ],
      },
    );
    await notifyWorkerWithPayload(client, result.invite.workerId, {
      embeds: [buildWorkerSuccessEmbed(result.netAmount)],
    });
    scheduleSpentRoleSync(result.invite.bossId, { announceVipUpgrade: true });
    scheduleSpentRoleSync(result.invite.workerId, { includeSpendRoles: false });
  } finally {
    settlingInviteIds.delete(inviteId);
  }
}

async function maybeSettleRoomInvites(client: Client, roomChannelId: string, channel: VoiceChannel) {
  const acceptedInvites = await prisma.auditionInvite.findMany({
    where: {
      roomChannelId,
      status: AuditionInviteStatus.ACCEPTED,
    },
    select: {
      id: true,
      bossId: true,
      workerId: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const now = Date.now();
  for (const invite of acceptedInvites) {
    if (invite.expiresAt.getTime() <= now) {
      await expireAuditionInvite(client, invite.id);
      continue;
    }
    if (!channel.members.has(invite.bossId)) continue;
    if (!channel.members.has(invite.workerId)) continue;
    await settleAuditionInvite(client, invite.id);
  }
}

async function syncAuditionRoomByChannelId(client: Client, channelId: string | null) {
  const normalized = String(channelId ?? '').trim();
  if (!normalized) return;
  const room = await prisma.auditionRoom.findUnique({
    where: { channelId: normalized },
    select: {
      bossId: true,
      channelId: true,
      emptySince: true,
    },
  });
  if (!room) return;

  const channel = await client.channels.fetch(normalized).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await deleteAuditionRoom(client, room.bossId, 'channel_missing');
    return;
  }

  await syncRoomStateFromChannel(client, room, channel);
  await maybeSettleRoomInvites(client, room.channelId, channel);
}

async function replyToButton(i: ButtonInteraction, content: string) {
  const payload = i.inGuild() ? { content, ephemeral: true } : { content };
  if (i.deferred || i.replied) {
    await i.followUp(payload);
    return;
  }
  await i.reply(payload);
}

async function replyToButtonWithPayload(
  i: ButtonInteraction,
  payload: InteractionReplyOptions,
) {
  const replyPayload = i.inGuild() ? { ...payload, ephemeral: true } : payload;
  if (i.deferred || i.replied) {
    await i.followUp(replyPayload);
    return;
  }
  await i.reply(replyPayload);
}

async function replyAlreadyHandled(i: ButtonInteraction) {
  if (!i.inGuild() && !i.deferred && !i.replied) {
    await i.deferUpdate().catch(() => null);
    return;
  }
  await replyToButton(i, '该真人试音邀请已处理，请勿重复操作。');
}

export async function handleAuditionRequestButton(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('audition:request:')) return;

  const parsed = parseAuditionRequestCustomId(i.customId);
  if (!parsed) {
    await replyToButton(i, '未能识别真人试音参数，请稍后重试。');
    return;
  }

  const orderRequest = await prisma.orderRequestLog.findUnique({
    where: { orderId: parsed.orderRequestId },
    select: { ownerId: true, createdAt: true },
  }).catch((err) => {
    console.error('[audition] load order request failed:', err);
    return null;
  });
  const ownerId = orderRequest?.ownerId ?? (await resolveOrderRequestOwnerId(parsed.orderRequestId, null));
  if (!ownerId || ownerId !== i.user.id) {
    await replyToButton(i, '这不是你的陪玩名片，无法发起真人试音。');
    return;
  }
  const requestCreatedAtMs =
    orderRequest?.createdAt?.getTime() ??
    (Number.isFinite(i.message?.createdTimestamp) ? i.message.createdTimestamp : null);
  if (isAuditionRequestExpired(requestCreatedAtMs)) {
    await replyToButton(i, '这张陪玩名片已过期，请让对方重新抢单。');
    return;
  }

  const now = new Date();

  const invitation = await prisma.$transaction(async (tx) => {
    await tx.member.upsert({
      where: { discordUserId: ownerId },
      create: { discordUserId: ownerId },
      update: {},
    });
    await tx.member.upsert({
      where: { discordUserId: parsed.workerId },
      create: { discordUserId: parsed.workerId },
      update: {},
    });
    await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "discordUserId" = ${ownerId} FOR UPDATE`;

    const workerPeiwan = await tx.pEIWAN.findUnique({
      where: { discordUserId: parsed.workerId },
      select: {
        PEIWANID: true,
        auditionInviteEnabled: true,
        serverDisplayName: true,
        member: { select: { status: true } },
      },
    });
    if (!workerPeiwan || workerPeiwan.member?.status !== MemberStatus.PEIWAN) {
      return { outcome: 'inactive' as const };
    }
    if (parsed.peiwanId != null && workerPeiwan.PEIWANID !== parsed.peiwanId) {
      return { outcome: 'stale' as const };
    }
    const deletionRecord = await tx.peiwanDeletion.findUnique({
      where: { peiwanId: workerPeiwan.PEIWANID },
      select: { peiwanId: true },
    });
    if (deletionRecord) {
      return { outcome: 'inactive' as const };
    }
    if (!workerPeiwan.auditionInviteEnabled) {
      return { outcome: 'disabled' as const };
    }

    await tx.auditionInvite.updateMany({
      where: {
        bossId: ownerId,
        workerId: parsed.workerId,
        status: { in: [...ACTIVE_INVITE_STATUSES] },
        expiresAt: { lte: now },
      },
      data: {
        status: AuditionInviteStatus.EXPIRED,
        canceledAt: now,
        failureReason: 'invite_expired',
      },
    });

    const existingActiveInvite = await tx.auditionInvite.findFirst({
      where: {
        bossId: ownerId,
        workerId: parsed.workerId,
        status: { in: [...ACTIVE_INVITE_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        expiresAt: true,
        roomChannelId: true,
        roomGuildId: true,
      },
    });
    if (existingActiveInvite) {
      return {
        outcome: 'duplicate' as const,
        invite: existingActiveInvite,
      };
    }

    const invite = await tx.auditionInvite.create({
      data: {
        orderRequestId: parsed.orderRequestId,
        bossId: ownerId,
        workerId: parsed.workerId,
        peiwanId: parsed.peiwanId ?? undefined,
        roomChannelId: '',
        roomGuildId: '',
        bossContactChannelId: i.channelId,
        expiresAt: new Date(now.getTime() + AUDITION_INVITE_EXPIRE_MS),
      },
    });

    return {
      outcome: 'created' as const,
      invite,
      workerDisplayName: workerPeiwan.serverDisplayName,
      peiwanId: workerPeiwan.PEIWANID,
    };
  });

  if (invitation.outcome === 'inactive' || invitation.outcome === 'stale') {
    await replyToButton(i, '该陪玩名片已失效，请让对方重新抢单。');
    return;
  }
  if (invitation.outcome === 'disabled') {
    await replyToButton(i, '该陪玩当前未开启真人试音邀请。');
    return;
  }
  if (invitation.outcome === 'duplicate') {
    scheduleInviteExpiry(i.client, invitation.invite.id, invitation.invite.expiresAt);
    const roomUrl =
      invitation.invite.roomChannelId && invitation.invite.roomGuildId
        ? buildChannelUrl(invitation.invite.roomGuildId, invitation.invite.roomChannelId)
        : null;
    await replyToButtonWithPayload(i, {
      content: buildDuplicateInviteNotice(roomUrl),
      components: buildBossCancelRow(invitation.invite.id),
    });
    return;
  }

  if (invitation.outcome !== 'created') {
    await replyToButton(i, '真人试音邀请创建失败，请稍后再试。');
    return;
  }

  let workerDmSent = false;
  try {
    const worker = await i.client.users.fetch(parsed.workerId);
    const dmMessage = await worker.send(buildWorkerDmPayload(invitation.invite.id, ownerId));
    workerDmSent = true;
    await prisma.auditionInvite.update({
      where: { id: invitation.invite.id },
      data: {
        workerPromptChannelId: dmMessage.channelId,
        workerPromptMessageId: dmMessage.id,
      },
    });
  } catch (err) {
    console.error('[audition] send worker invite failed:', err);
    await prisma.auditionInvite.update({
      where: { id: invitation.invite.id },
      data: {
        status: AuditionInviteStatus.CANCELED,
        canceledAt: new Date(),
        failureReason: 'worker_dm_failed',
      },
    });
  }

  if (!workerDmSent) {
    await replyToButton(i, '未能向该陪玩发送真人试音私信，本次邀请未生效。');
    return;
  }

  scheduleInviteExpiry(i.client, invitation.invite.id, invitation.invite.expiresAt);
  await replyToButtonWithPayload(i, {
    embeds: [buildInviteSentEmbed(parsed.workerId, invitation.peiwanId, invitation.workerDisplayName)],
    components: buildBossCancelRow(invitation.invite.id),
  });
}

export async function handleAuditionAcceptButton(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('audition:accept:')) return;

  const inviteId = parseAuditionInviteCustomId(i.customId, 'accept');
  if (!inviteId) {
    await replyToButton(i, '未能识别真人试音邀请。');
    return;
  }

  const initialNow = new Date();
  const invite = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "AuditionInvite" WHERE "id" = ${inviteId} FOR UPDATE`;
    const current = await tx.auditionInvite.findUnique({ where: { id: inviteId } });
    if (!current) return null;
    if (current.workerId !== i.user.id) throw new Error('NOT_WORKER');
    if (!ACTIVE_INVITE_STATUSES.includes(current.status as (typeof ACTIVE_INVITE_STATUSES)[number])) {
      return current;
    }
    if (current.expiresAt.getTime() <= initialNow.getTime()) {
      return tx.auditionInvite.update({
        where: { id: inviteId },
        data: {
          status: AuditionInviteStatus.EXPIRED,
          canceledAt: initialNow,
          failureReason: 'invite_expired',
        },
      });
    }
    return current;
  }).catch(async (err) => {
    if (err instanceof Error && err.message === 'NOT_WORKER') return 'NOT_WORKER' as const;
    throw err;
  });

  if (invite === 'NOT_WORKER') {
    await replyToButton(i, '您不是这条真人试音邀请的目标陪玩。');
    return;
  }
  if (!invite) {
    await replyToButton(i, '真人试音邀请不存在或已失效。');
    return;
  }
  if (invite.status === AuditionInviteStatus.EXPIRED) {
    cancelInviteTimer(invite.id);
    await i.update({ components: buildStateRow('邀请已过期') });
    await notifyBoss(i.client, invite.bossId, invite.bossContactChannelId, buildBossPendingExpireNotice(invite.workerId, invite.peiwanId));
    return;
  }
  if (invite.status !== AuditionInviteStatus.PENDING && invite.status !== AuditionInviteStatus.ACCEPTED) {
    await replyAlreadyHandled(i);
    return;
  }

  const requestLog = await prisma.orderRequestLog.findUnique({
    where: { orderId: invite.orderRequestId },
    select: { ownerDisplayName: true },
  });
  const bossDisplayName = await resolveBossRoomLabel(i.client, invite.bossId, requestLog?.ownerDisplayName);

  let room;
  try {
    const resolvedRoom = await ensureAuditionRoom(i.client, invite.bossId, bossDisplayName);
    room = resolvedRoom.room;
  } catch (err) {
    console.error('[audition] ensure room failed:', err);
    const canceled = await prisma.auditionInvite.update({
      where: { id: invite.id },
      data: {
        status: AuditionInviteStatus.CANCELED,
        canceledAt: new Date(),
        failureReason: 'room_create_failed',
      },
    }).catch(() => null);
    cancelInviteTimer(invite.id);
    await i.update({ components: buildStateRow('试音厅创建失败') });
    await notifyBoss(
      i.client,
      invite.bossId,
      canceled?.bossContactChannelId ?? invite.bossContactChannelId,
      '试音厅创建失败，本次真人试音邀请未能生效，请稍后重试。',
    );
    await replyToButton(i, '创建试音厅失败，请稍后让老板重新发起真人试音邀请。');
    return;
  }

  const acceptedNow = new Date();
  const acceptedInvite = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "AuditionInvite" WHERE "id" = ${inviteId} FOR UPDATE`;
    const current = await tx.auditionInvite.findUnique({ where: { id: inviteId } });
    if (!current) return null;
    if (current.workerId !== i.user.id) throw new Error('NOT_WORKER');
    if (!ACTIVE_INVITE_STATUSES.includes(current.status as (typeof ACTIVE_INVITE_STATUSES)[number])) {
      return current;
    }
    if (current.expiresAt.getTime() <= acceptedNow.getTime()) {
      return tx.auditionInvite.update({
        where: { id: inviteId },
        data: {
          status: AuditionInviteStatus.EXPIRED,
          canceledAt: acceptedNow,
          failureReason: 'invite_expired',
        },
      });
    }
    return tx.auditionInvite.update({
      where: { id: inviteId },
      data: {
        status: AuditionInviteStatus.ACCEPTED,
        acceptedAt: current.acceptedAt ?? acceptedNow,
        roomChannelId: room.channelId,
        roomGuildId: room.guildId,
        expiresAt: new Date(acceptedNow.getTime() + AUDITION_INVITE_EXPIRE_MS),
      },
    });
  }).catch(async (err) => {
    if (err instanceof Error && err.message === 'NOT_WORKER') return 'NOT_WORKER' as const;
    throw err;
  });

  if (acceptedInvite === 'NOT_WORKER') {
    await replyToButton(i, '您不是这条真人试音邀请的目标陪玩。');
    return;
  }
  if (!acceptedInvite) {
    await replyToButton(i, '真人试音邀请不存在或已失效。');
    return;
  }
  if (acceptedInvite.status === AuditionInviteStatus.EXPIRED) {
    cancelInviteTimer(acceptedInvite.id);
    await i.update({ components: buildStateRow('邀请已过期') });
    await notifyBoss(
      i.client,
      acceptedInvite.bossId,
      acceptedInvite.bossContactChannelId,
      buildBossAcceptedExpireNotice(acceptedInvite.workerId, acceptedInvite.peiwanId),
    );
    return;
  }
  if (acceptedInvite.status !== AuditionInviteStatus.ACCEPTED) {
    await replyAlreadyHandled(i);
    return;
  }

  const roomUrl = buildChannelUrl(room.guildId, room.channelId);
  const workerIdentity = await resolvePeiwanIdentity(
    i.client,
    acceptedInvite.workerId,
    acceptedInvite.peiwanId,
  );
  scheduleInviteExpiry(i.client, acceptedInvite.id, acceptedInvite.expiresAt);
  await i.update({ components: buildStateRow('已接受，请立即进房') });
  await notifyBossWithPayload(i.client, acceptedInvite.bossId, acceptedInvite.bossContactChannelId, {
    embeds: [
      buildBossAcceptedRoomEmbed(
        acceptedInvite.workerId,
        workerIdentity.peiwanId,
        workerIdentity.workerDisplayName,
        roomUrl,
      ),
    ],
    components: buildBossCancelRow(acceptedInvite.id),
  });
  await replyToButtonWithPayload(i, {
    embeds: [buildWorkerAcceptedRoomEmbed(roomUrl, acceptedInvite.bossId)],
  });
  await syncAuditionRoomByChannelId(i.client, room.channelId);
}

export async function handleAuditionCancelButton(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('audition:cancel:')) return;

  const inviteId = parseAuditionInviteCustomId(i.customId, 'cancel');
  if (!inviteId) {
    await replyToButton(i, '未能识别真人试音邀请。');
    return;
  }

  const inviteSnapshot = await prisma.auditionInvite.findUnique({
    where: { id: inviteId },
    select: {
      id: true,
      bossId: true,
      workerId: true,
      roomChannelId: true,
      status: true,
    },
  });

  if (!inviteSnapshot) {
    await replyToButton(i, '真人试音邀请不存在或已失效。');
    return;
  }
  if (inviteSnapshot.bossId !== i.user.id) {
    await replyToButton(i, '只有发起真人试音的老板才能取消这条邀请。');
    return;
  }
  if (!ACTIVE_INVITE_STATUSES.includes(inviteSnapshot.status as (typeof ACTIVE_INVITE_STATUSES)[number])) {
    await replyAlreadyHandled(i);
    return;
  }

  const assignedRoomId = String(inviteSnapshot.roomChannelId ?? '').trim();
  if (assignedRoomId) {
    const roomChannel =
      i.client.channels.cache.get(assignedRoomId) ??
      (await i.client.channels.fetch(assignedRoomId).catch((err) => {
        console.error('[audition] fetch room before cancel failed:', err);
        return null;
      }));
    if (!roomChannel) {
      await replyToButton(i, '当前无法确认试音频道状态，请稍后再试。');
      return;
    }
    if (roomChannel.type === ChannelType.GuildVoice) {
      const bossPresent = roomChannel.members.has(inviteSnapshot.bossId);
      const workerPresent = roomChannel.members.has(inviteSnapshot.workerId);
      if (bossPresent && workerPresent) {
        await replyToButton(i, '老板和陪玩已经同时在试音频道中，当前不能取消真人试音。');
        return;
      }
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "AuditionInvite" WHERE "id" = ${inviteId} FOR UPDATE`;
    const current = await tx.auditionInvite.findUnique({ where: { id: inviteId } });
    if (!current) return { outcome: 'missing' as const };
    if (current.bossId !== i.user.id) return { outcome: 'not_boss' as const };
    if (!ACTIVE_INVITE_STATUSES.includes(current.status as (typeof ACTIVE_INVITE_STATUSES)[number])) {
      return { outcome: 'inactive' as const };
    }

    const invite = await tx.auditionInvite.update({
      where: { id: inviteId },
      data: {
        status: AuditionInviteStatus.CANCELED,
        canceledAt: new Date(),
        failureReason: 'boss_canceled',
      },
    });
    return { outcome: 'canceled' as const, invite };
  });

  if (result.outcome === 'not_boss') {
    await replyToButton(i, '只有发起真人试音的老板才能取消这条邀请。');
    return;
  }
  if (result.outcome === 'missing') {
    await replyToButton(i, '真人试音邀请不存在或已失效。');
    return;
  }
  if (result.outcome === 'inactive') {
    await replyAlreadyHandled(i);
    return;
  }
  if (result.outcome !== 'canceled') {
    await replyToButton(i, '取消真人试音失败，请稍后再试。');
    return;
  }

  const invite = result.invite;
  cancelInviteTimer(invite.id);
  await updateInviteMessageState(i.client, invite, '老板已取消');
  await i.update({ components: buildStateRow('已取消') });
  await notifyWorker(i.client, invite.workerId, buildWorkerCanceledNotice('老板已取消本次真人试音邀请。'));
}

export async function handleAuditionDeclineButton(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('audition:decline:')) return;

  const inviteId = parseAuditionInviteCustomId(i.customId, 'decline');
  if (!inviteId) {
    await replyToButton(i, '未能识别真人试音邀请。');
    return;
  }

  const now = new Date();
  const invite = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "AuditionInvite" WHERE "id" = ${inviteId} FOR UPDATE`;
    const current = await tx.auditionInvite.findUnique({ where: { id: inviteId } });
    if (!current) return null;
    if (current.workerId !== i.user.id) throw new Error('NOT_WORKER');
    if (!ACTIVE_INVITE_STATUSES.includes(current.status as (typeof ACTIVE_INVITE_STATUSES)[number])) {
      return current;
    }
    return tx.auditionInvite.update({
      where: { id: inviteId },
      data: {
        status: AuditionInviteStatus.REJECTED,
        declinedAt: now,
        canceledAt: now,
        failureReason: 'worker_declined',
      },
    });
  }).catch(async (err) => {
    if (err instanceof Error && err.message === 'NOT_WORKER') return 'NOT_WORKER' as const;
    throw err;
  });

  if (invite === 'NOT_WORKER') {
    await replyToButton(i, '您不是这条真人试音邀请的目标陪玩。');
    return;
  }
  if (!invite) {
    await replyToButton(i, '真人试音邀请不存在或已失效。');
    return;
  }
  if (invite.status !== AuditionInviteStatus.REJECTED) {
    await replyAlreadyHandled(i);
    return;
  }

  cancelInviteTimer(invite.id);
  await i.update({ components: buildStateRow('已拒绝') });
  await notifyBoss(i.client, invite.bossId, invite.bossContactChannelId, buildBossRejectNotice(invite.workerId, invite.peiwanId));
}

async function recoverAuditionRooms(client: Client) {
  const rooms = await prisma.auditionRoom.findMany({
    select: {
      bossId: true,
      channelId: true,
      emptySince: true,
    },
  });

  for (const room of rooms) {
    const channel = await client.channels.fetch(room.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await deleteAuditionRoom(client, room.bossId, 'channel_missing');
      continue;
    }
    await syncRoomStateFromChannel(client, room, channel);
    await maybeSettleRoomInvites(client, room.channelId, channel);
  }
}

async function recoverAuditionInvites(client: Client) {
  const invites = await prisma.auditionInvite.findMany({
    where: { status: { in: [...ACTIVE_INVITE_STATUSES] } },
    select: { id: true, expiresAt: true },
  });

  for (const invite of invites) {
    scheduleInviteExpiry(client, invite.id, invite.expiresAt);
  }
}

export async function recoverAuditionState(client: Client) {
  await recoverAuditionRooms(client);
  await recoverAuditionInvites(client);
}

async function handleAuditionVoiceStateUpdate(client: Client, oldState: VoiceState, newState: VoiceState) {
  const channelIds = new Set<string>();
  if (oldState.channelId) channelIds.add(oldState.channelId);
  if (newState.channelId) channelIds.add(newState.channelId);

  for (const channelId of channelIds) {
    await syncAuditionRoomByChannelId(client, channelId);
  }
}

export function registerAuditionService(client: Client) {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleAuditionVoiceStateUpdate(client, oldState, newState).catch((err) =>
      console.error('[audition] voiceStateUpdate failed:', err),
    );
  });
}
