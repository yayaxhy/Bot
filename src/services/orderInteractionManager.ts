import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Message,
  TextChannel,
} from 'discord.js';
import prisma from '../db/prisma.js';
import { OrderStatus } from '@prisma/client';
import { MIN } from '../lib/time.js';
import { clickStore, type ClickMessageKind } from './clickStore.js';
import { ORDER_REQUEST_CLOSED_HINT } from '../constants/orderRequestCopy.js';

export const ORDER_REQUEST_CLOSE_MS = 20 * MIN;
export const INVITATION_EXPIRE_MS = 10 * MIN;
const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const CLOSED_ORDER_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const DISCORD_EPOCH_MS = 1420070400000;

const requestTimers = new Map<string, NodeJS.Timeout>();
const trackedRequestTimers = new Map<string, NodeJS.Timeout>();
const invitationTimers = new Map<string, NodeJS.Timeout>();
const invitationMessages = new Map<string, Message>();
const expiredInvitations = new Set<string>();
const closedOrderRequests = new Map<string, 'manual' | 'timeout'>();
const closedOrderRequestCleanupTimers = new Map<string, NodeJS.Timeout>();

function makePublicClosedRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('request:closed')
      .setLabel('派单已关闭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

function makeOwnerClosedRow(orderId: string, ownerId: string, reason: 'manual' | 'timeout') {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`requestEnd:${orderId}:${ownerId}`)
      .setLabel(reason === 'manual' ? '已结束派单' : '派单已关闭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

function buildPublicClosePayload(kind: ClickMessageKind, closedContent?: string | null) {
  const row = makePublicClosedRow();
  if (kind === 'broadcast' && closedContent != null) {
    return { content: closedContent, components: [row] };
  }
  return { components: [row] };
}

function scheduleClosedOrderRequestCleanup(orderId: string) {
  const existing = closedOrderRequestCleanupTimers.get(orderId);
  if (existing) clearTimeout(existing);
  closedOrderRequestCleanupTimers.set(
    orderId,
    setTimeout(() => {
      closedOrderRequestCleanupTimers.delete(orderId);
      closedOrderRequests.delete(orderId);
    }, CLOSED_ORDER_REQUEST_TTL_MS),
  );
}

export function getOrderRequestCloseReason(orderId: string): 'manual' | 'timeout' | null {
  return closedOrderRequests.get(orderId) ?? null;
}

export function markOrderRequestClosed(orderId: string, reason: 'manual' | 'timeout') {
  if (!orderId) return;
  if (!closedOrderRequests.has(orderId)) {
    closedOrderRequests.set(orderId, reason);
  }
  scheduleClosedOrderRequestCleanup(orderId);
}

export function cancelOrderRequestClosures(messageIds: string[]) {
  for (const messageId of messageIds) {
    const timer = requestTimers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      requestTimers.delete(messageId);
    }
  }
}

export function cancelTrackedOrderRequestClosure(orderId: string) {
  const timer = trackedRequestTimers.get(orderId);
  if (timer) {
    clearTimeout(timer);
    trackedRequestTimers.delete(orderId);
  }
}

export function registerOrderRequestOwnerControl(orderId: string, ownerId: string, message: Message) {
  if (!orderId || !ownerId) return;
  clickStore.registerOwnerControl(orderId, ownerId, message.id, message.channelId);
}

export async function syncOrderRequestOwnerControls(
  client: Client,
  orderId: string,
  reason: 'manual' | 'timeout',
) {
  const items = clickStore.getOwnerControls(orderId);
  for (const item of items) {
    try {
      const channel = await client.channels.fetch(item.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('messages' in channel)) continue;
      const message = await (channel as TextChannel).messages.fetch(item.messageId).catch(() => null);
      if (!message?.editable) continue;
      await message.edit({ components: [makeOwnerClosedRow(orderId, item.ownerId, reason)] });
    } catch (err) {
      console.error('[orderInteractionManager] sync owner control failed:', err);
    }
  }
}

async function closeOrderRequestMessage(message: Message, closedContent?: string | null) {
  if (!message.editable) return;
  try {
    await message.edit(buildPublicClosePayload('body', closedContent));
  } catch (err) {
    console.error('[orderInteractionManager] close order request message failed:', err);
  }
}

async function closeTrackedOrderRequest(
  client: Client,
  orderId: string,
  closedContent?: string | null,
) {
  const existingReason = getOrderRequestCloseReason(orderId);
  if (existingReason) return;

  markOrderRequestClosed(orderId, 'timeout');
  cancelTrackedOrderRequestClosure(orderId);
  const targets = clickStore.getMessages(orderId, 'body');

  for (const target of targets) {
    try {
      const channel = await client.channels.fetch(target.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('messages' in channel)) continue;
      const message = await (channel as TextChannel).messages.fetch(target.messageId).catch(() => null);
      if (!message?.editable) continue;
      await message.edit(buildPublicClosePayload(target.kind, closedContent));
    } catch (err) {
      console.error('[orderInteractionManager] sync closed order request failed:', err);
    }
  }

  await syncOrderRequestOwnerControls(client, orderId, 'timeout');
  clickStore.remove(orderId);
}

function scheduleTrackedOrderRequestClosure(
  client: Client,
  orderId: string,
  timeoutMs = ORDER_REQUEST_CLOSE_MS,
  closedContent: string | null = null,
) {
  const existing = trackedRequestTimers.get(orderId);
  if (existing) clearTimeout(existing);

  trackedRequestTimers.set(
    orderId,
    setTimeout(async () => {
      trackedRequestTimers.delete(orderId);
      await closeTrackedOrderRequest(client, orderId, closedContent);
    }, timeoutMs),
  );
}

export function scheduleOrderRequestClosure(
  message: Message,
  timeoutMs = ORDER_REQUEST_CLOSE_MS,
  closedContent: string | null = null,
  orderId?: string,
) {
  if (orderId) {
    scheduleTrackedOrderRequestClosure(message.client, orderId, timeoutMs, closedContent);
    return;
  }

  const key = message.id;
  const existing = requestTimers.get(key);
  if (existing) clearTimeout(existing);

  requestTimers.set(
    key,
    setTimeout(async () => {
      requestTimers.delete(key);
      await closeOrderRequestMessage(message, closedContent);
    }, timeoutMs),
  );
}

function estimateSnowflakeTimestamp(orderId: string): Date | null {
  try {
    const snowflake = BigInt(orderId);
    const timestamp = Number((snowflake >> 22n) + BigInt(DISCORD_EPOCH_MS));
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return new Date(timestamp);
  } catch {
    return null;
  }
}

export async function recoverPendingOrderRequests(client: Client, now = new Date()) {
  await clickStore.ready();
  const openRequests = clickStore.listOpenRequests();
  if (openRequests.length === 0) return;

  const requestLogs = await prisma.orderRequestLog.findMany({
    where: { orderId: { in: openRequests.map((request) => request.orderId) } },
    select: { orderId: true, createdAt: true },
  });
  const createdAtByOrderId = new Map(requestLogs.map((item) => [item.orderId, item.createdAt]));

  for (const request of openRequests) {
    const createdAt = createdAtByOrderId.get(request.orderId) ?? estimateSnowflakeTimestamp(request.orderId);
    if (!createdAt) {
      console.warn('[orderInteractionManager] unable to recover order request without timestamp:', request.orderId);
      continue;
    }

    const remainingMs = ORDER_REQUEST_CLOSE_MS - (now.getTime() - createdAt.getTime());
    if (remainingMs <= 0) {
      await closeTrackedOrderRequest(client, request.orderId, ORDER_REQUEST_CLOSED_HINT);
      continue;
    }

    scheduleTrackedOrderRequestClosure(client, request.orderId, remainingMs, ORDER_REQUEST_CLOSED_HINT);
  }
}

async function expireInvitation(orderId: string) {
  expiredInvitations.add(orderId);

  const msg = invitationMessages.get(orderId);
  if (msg?.editable) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`invite:expired:${orderId}`)
        .setLabel('邀请已过期')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );
    try {
      await msg.edit({ components: [row] });
    } catch (err) {
      console.error('[orderInteractionManager] update expired invitation message failed:', err);
    }
  }

  invitationMessages.delete(orderId);

  const timer = invitationTimers.get(orderId);
  if (timer) clearTimeout(timer);
  invitationTimers.delete(orderId);

  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, hostId: true, displayNo: true },
    });

    if (!order || order.status !== OrderStatus.PENDING) return;

    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELED, endedAt: new Date() },
    });

    if (order.hostId) {
      try {
        const client = msg?.client ?? (globalThis as any).__CLIENT__;
        if (client) {
          const user = await client.users.fetch(order.hostId);
          const displayId = order.displayNo != null ? `${ORDER_ID_PREFIX}${order.displayNo}` : `${ORDER_ID_PREFIX}—`;
          await user.send(`订单 ${displayId} 的邀请已过期，陪玩未在 10 分钟内回应。`);
        }
      } catch (err) {
        console.error('[orderInteractionManager] notify host about expired invitation failed:', err);
      }
    }
  } catch (err) {
    console.error('[orderInteractionManager] expire invitation failed:', err);
  }
}

export function registerInvitationMessage(
  orderId: string,
  message: Message,
  timeoutMs = INVITATION_EXPIRE_MS,
) {
  const existingTimer = invitationTimers.get(orderId);
  if (existingTimer) clearTimeout(existingTimer);

  invitationMessages.set(orderId, message);
  invitationTimers.set(
    orderId,
    setTimeout(() => {
      expireInvitation(orderId);
    }, timeoutMs),
  );
}

export async function markInvitationHandled(orderId: string) {
  expiredInvitations.delete(orderId);

  const timer = invitationTimers.get(orderId);
  if (timer) clearTimeout(timer);
  invitationTimers.delete(orderId);

  const msg = invitationMessages.get(orderId);
  invitationMessages.delete(orderId);

  if (msg?.editable) {
    try {
      await msg.edit({ components: [] });
    } catch (err) {
      console.error('[orderInteractionManager] clear invitation components failed:', err);
    }
  }
}

export function isInvitationExpired(orderId: string): boolean {
  return expiredInvitations.has(orderId);
}

/** Recover pending invitations after a restart so they still expire. */
export async function recoverPendingInvitations(now = new Date()) {
  const pending = await prisma.order.findMany({
    where: { status: OrderStatus.PENDING },
    select: { id: true, createdAt: true },
  });

  for (const order of pending) {
    const ageMs = now.getTime() - order.createdAt.getTime();
    const remainingMs = INVITATION_EXPIRE_MS - ageMs;
    if (remainingMs <= 0) {
      await expireInvitation(order.id);
      continue;
    }

    const existing = invitationTimers.get(order.id);
    if (existing) clearTimeout(existing);
    invitationTimers.set(
      order.id,
      setTimeout(() => {
        expireInvitation(order.id);
      }, remainingMs),
    );
  }
}
