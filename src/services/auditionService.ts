import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  userMention,
  type MessageCreateOptions,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { AuditionInviteStatus, Prisma } from '@prisma/client';
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

function buildRoomNotice(channelUrl: string) {
  return [
    `您的临时试音厅已经创建：${channelUrl}`,
    '请老板移步到试音厅等待陪玩试音。真人试音邀请会在两分钟后过期，超过两分钟如果陪玩没有出现在试音厅则视为拒绝试音邀请，老板可以选择点击该陪玩名片下方的语音条进行试音。',
  ].join('\n');
}

function buildInviteSentNotice(channelUrl: string) {
  return `已向陪玩发送真人试音邀请。试音厅链接：${channelUrl}`;
}

function buildDuplicateInviteNotice(channelUrl: string) {
  return `该陪玩已有待处理的真人试音邀请，请等待对方进入试音厅或邀请过期。试音厅链接：${channelUrl}`;
}

function buildWorkerDmPayload(inviteId: string, bossId: string, channelUrl: string): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setColor(0xf5a623)
    .setTitle('真人试音邀请')
    .setDescription(
      [
        `${userMention(bossId)} 老板邀请你进行真人试音`,
        `请在两分钟内到 ${channelUrl} 进行试音`,
        `进入试音厅后可获得 ${AUDITION_PRICE.toString()} 锦鲤币试音收入（按当前抽成结算）`,
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

function buildBossRejectNotice(workerId: string, peiwanId: number | null | undefined) {
  const peiwanText = peiwanId != null ? `陪玩 ${peiwanId}` : '该陪玩';
  return `<@${workerId}> ${peiwanText} 正在忙，拒绝了您的真人试音邀请`;
}

function buildBossExpireNotice(workerId: string, peiwanId: number | null | undefined) {
  const peiwanText = peiwanId != null ? `陪玩 ${peiwanId}` : '该陪玩';
  return `<@${workerId}> ${peiwanText} 未在两分钟内出现在试音厅，已视为拒绝真人试音邀请。您可以选择点击该陪玩名片下方的语音条进行试音。`;
}

function buildBossInsufficientBalanceNotice(workerId: string, peiwanId: number | null | undefined) {
  const peiwanText = peiwanId != null ? `陪玩 ${peiwanId}` : '该陪玩';
  return `${peiwanText} 已进入试音厅，但您的可用余额不足，真人试音未能生效。请充值后重新邀请 ${userMention(workerId)}。`;
}

function buildBossSuccessNotice(workerId: string) {
  return `${userMention(workerId)} 已进入试音厅，本次真人试音已扣除 ${AUDITION_PRICE.toString()} 锦鲤币。`;
}

function buildWorkerSuccessNotice(netAmount: Prisma.Decimal) {
  return `您已进入试音厅，本次真人试音收入 ${netAmount.toFixed(2)} 锦鲤币。`;
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

function parseAuditionInviteCustomId(customId: string, action: 'accept' | 'decline') {
  const parts = customId.split(':');
  if (parts.length < 3) return null;
  if (parts[1] !== action) return null;
  return parts[2] || null;
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
  try {
    const user = await client.users.fetch(bossId);
    await user.send(content);
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
      await fallbackChannel.send({
        content: `<@${bossId}> ${content}`,
        allowedMentions: { parse: ['users'] },
      });
    } catch (err) {
      console.error('[audition] notify boss fallback failed:', err);
    }
  }
}

async function notifyWorker(client: Client, workerId: string, content: string) {
  try {
    const user = await client.users.fetch(workerId);
    await user.send(content);
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
  const existing = await prisma.auditionRoom.findUnique({ where: { bossId } });
  if (existing) {
    const channel = await client.channels.fetch(existing.channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildVoice) {
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

  const channelName = `${sanitizeBossLabel(bossDisplayName)}的试音厅`;
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
    await notifyBoss(
      client,
      invite.bossId,
      invite.bossContactChannelId,
      buildBossExpireNotice(invite.workerId, invite.peiwanId),
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

      await applyJinleeWalletDeltaTx(tx, {
        jinleeId: bossIdentity.jinleeId,
        discordUserId: bossIdentity.discordUserId,
        incomeDelta: bossSplit.fromIncome.neg(),
        rechargeDelta: bossSplit.fromRecharge.neg(),
        totalBalanceDelta: gross.neg(),
      });

      const bossIndividualTx = await recordIndividualTransaction(tx, {
        discordId: bossIdentity.discordUserId,
        jinleeId: bossIdentity.jinleeId,
        thirdPartydiscordId: invite.workerId,
        balanceBefore: bossWallet.totalBalance,
        amountChange: gross,
        balanceAfter: bossSplit.totalAfter,
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
        buildBossExpireNotice(result.invite.workerId, result.invite.peiwanId),
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

    await updateInviteMessageState(client, result.invite, '真人试音已完成');
    await notifyBoss(
      client,
      result.invite.bossId,
      result.invite.bossContactChannelId,
      buildBossSuccessNotice(result.invite.workerId),
    );
    await notifyWorker(client, result.invite.workerId, buildWorkerSuccessNotice(result.netAmount));
  } finally {
    settlingInviteIds.delete(inviteId);
  }
}

async function maybeSettleRoomInvites(client: Client, roomChannelId: string, channel: VoiceChannel) {
  const activeInvites = await prisma.auditionInvite.findMany({
    where: {
      roomChannelId,
      status: { in: [...ACTIVE_INVITE_STATUSES] },
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
  for (const invite of activeInvites) {
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

export async function handleAuditionRequestButton(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('audition:request:')) return;

  const parsed = parseAuditionRequestCustomId(i.customId);
  if (!parsed) {
    await replyToButton(i, '未能识别真人试音参数，请稍后重试。');
    return;
  }

  const ownerId = await resolveOrderRequestOwnerId(parsed.orderRequestId, null);
  if (!ownerId || ownerId !== i.user.id) {
    await replyToButton(i, '这不是你的陪玩名片，无法发起真人试音。');
    return;
  }

  const requestLog = await prisma.orderRequestLog.findUnique({
    where: { orderId: parsed.orderRequestId },
    select: { ownerDisplayName: true },
  });
  const bossDisplayName = requestLog?.ownerDisplayName?.trim() || i.user.globalName || i.user.username;
  const { room } = await ensureAuditionRoom(i.client, ownerId, bossDisplayName);
  const roomUrl = buildChannelUrl(room.guildId, room.channelId);
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
    });
    if (existingActiveInvite) {
      return { invite: existingActiveInvite, created: false, shouldSendRoomNotice: false };
    }

    const hasRoomNoticeForOrder = await tx.auditionInvite.findFirst({
      where: {
        bossId: ownerId,
        orderRequestId: parsed.orderRequestId,
        roomChannelId: room.channelId,
        bossRoomNoticeSentAt: { not: null },
      },
      select: { id: true },
    });

    const invite = await tx.auditionInvite.create({
      data: {
        orderRequestId: parsed.orderRequestId,
        bossId: ownerId,
        workerId: parsed.workerId,
        peiwanId: parsed.peiwanId ?? undefined,
        roomChannelId: room.channelId,
        roomGuildId: room.guildId,
        bossContactChannelId: i.channelId,
        expiresAt: new Date(now.getTime() + AUDITION_INVITE_EXPIRE_MS),
        bossRoomNoticeSentAt: hasRoomNoticeForOrder ? null : now,
      },
    });

    return {
      invite,
      created: true,
      shouldSendRoomNotice: !hasRoomNoticeForOrder,
    };
  });

  if (!invitation.created) {
    scheduleInviteExpiry(i.client, invitation.invite.id, invitation.invite.expiresAt);
    await replyToButton(i, buildDuplicateInviteNotice(roomUrl));
    return;
  }

  let workerDmSent = false;
  try {
    const worker = await i.client.users.fetch(parsed.workerId);
    const dmMessage = await worker.send(buildWorkerDmPayload(invitation.invite.id, ownerId, roomUrl));
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
    const content = invitation.shouldSendRoomNotice
      ? `${buildRoomNotice(roomUrl)}\n\n未能向该陪玩发送真人试音私信，本次邀请未生效。`
      : '未能向该陪玩发送真人试音私信，本次邀请未生效。';
    await replyToButton(i, content);
    return;
  }

  scheduleInviteExpiry(i.client, invitation.invite.id, invitation.invite.expiresAt);

  const content = invitation.shouldSendRoomNotice
    ? `${buildRoomNotice(roomUrl)}\n\n${buildInviteSentNotice(roomUrl)}`
    : buildInviteSentNotice(roomUrl);
  await replyToButton(i, content);
}

export async function handleAuditionAcceptButton(i: ButtonInteraction) {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('audition:accept:')) return;

  const inviteId = parseAuditionInviteCustomId(i.customId, 'accept');
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
    if (current.expiresAt.getTime() <= now.getTime()) {
      return tx.auditionInvite.update({
        where: { id: inviteId },
        data: {
          status: AuditionInviteStatus.EXPIRED,
          canceledAt: now,
          failureReason: 'invite_expired',
        },
      });
    }
    return tx.auditionInvite.update({
      where: { id: inviteId },
      data: {
        status: AuditionInviteStatus.ACCEPTED,
        acceptedAt: current.acceptedAt ?? now,
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
  if (invite.status === AuditionInviteStatus.EXPIRED) {
    cancelInviteTimer(invite.id);
    await i.update({ components: buildStateRow('邀请已过期') });
    await notifyBoss(i.client, invite.bossId, invite.bossContactChannelId, buildBossExpireNotice(invite.workerId, invite.peiwanId));
    return;
  }
  if (invite.status !== AuditionInviteStatus.ACCEPTED) {
    await replyToButton(i, '该真人试音邀请已处理，请勿重复操作。');
    return;
  }

  scheduleInviteExpiry(i.client, invite.id, invite.expiresAt);
  await i.update({ components: buildStateRow('已接受，等待进入试音厅') });
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
    await replyToButton(i, '该真人试音邀请已处理，请勿重复操作。');
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
