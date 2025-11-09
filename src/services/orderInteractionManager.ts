import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
} from 'discord.js';
import prisma from '../db/prisma.js';
import { OrderStatus } from '@prisma/client';
import { MIN } from '../lib/time.js';

const ORDER_REQUEST_CLOSE_MS = 20 * MIN;
const INVITATION_EXPIRE_MS = 10 * MIN;

const requestTimers = new Map<string, NodeJS.Timeout>();
const invitationTimers = new Map<string, NodeJS.Timeout>();
const invitationMessages = new Map<string, Message>();
const expiredInvitations = new Set<string>();

async function closeOrderRequestMessage(message: Message) {
  if (!message.editable) return;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('request:closed')
      .setLabel('派单已关闭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  try {
    await message.edit({ components: [row] });
  } catch (err) {
    console.error('[orderInteractionManager] close order request message failed:', err);
  }
}

export function scheduleOrderRequestClosure(message: Message, timeoutMs = ORDER_REQUEST_CLOSE_MS) {
  const key = message.id;
  const existing = requestTimers.get(key);
  if (existing) clearTimeout(existing);

  requestTimers.set(
    key,
    setTimeout(() => {
      requestTimers.delete(key);
      closeOrderRequestMessage(message);
    }, timeoutMs),
  );
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
      select: { status: true, hostId: true },
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
          await user.send(`订单 ${orderId} 的邀请已过期，陪玩未在 10 分钟内回应。`);
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
