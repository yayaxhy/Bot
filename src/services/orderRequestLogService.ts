import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';

export async function recordOrderRequest(params: {
  orderId: string;
  ownerId: string;
  content: string;
  ownerDisplayName?: string | null;
}): Promise<void> {
  const { orderId, ownerId, content, ownerDisplayName } = params;
  if (!orderId || !ownerId) return;
  const normalizedContent = content?.trim() ?? '';
  if (!normalizedContent) return;

  try {
    await prisma.orderRequestLog.upsert({
      where: { orderId },
      create: {
        orderId,
        ownerId,
        content: normalizedContent,
        ownerDisplayName: ownerDisplayName?.trim() || null,
      },
      update: {
        ownerId,
        content: normalizedContent,
        ownerDisplayName: ownerDisplayName?.trim() || null,
      },
    });
  } catch (err) {
    console.error('[order-request] record failed', err);
  }
}

export async function recordOrderClick(params: {
  orderId: string;
  workerId: string;
  workerDisplayName?: string | null;
}): Promise<void> {
  const { orderId, workerId, workerDisplayName } = params;
  if (!orderId || !workerId) return;

  try {
    await prisma.orderRequestClick.create({
      data: {
        orderId,
        workerId,
        workerDisplayName: workerDisplayName?.trim() || null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2002' || err.code === 'P2003')) {
      return;
    }
    console.error('[order-request] click record failed', err);
  }
}

export async function resolveOrderRequestOwnerId(
  orderId: string,
  fallbackOwnerId?: string | null
): Promise<string | null> {
  if (!orderId) return fallbackOwnerId?.trim() || null;

  try {
    const request = await prisma.orderRequestLog.findUnique({
      where: { orderId },
      select: { ownerId: true },
    });
    if (request?.ownerId) return request.ownerId;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { hostId: true },
    });
    if (order?.hostId) return order.hostId;
  } catch (err) {
    console.error('[order-request] resolve owner failed', err);
  }

  return fallbackOwnerId?.trim() || null;
}

export async function resolveOrderRequestContent(
  orderId: string,
  fallbackContent?: string | null,
): Promise<string> {
  const fallback = fallbackContent?.trim() ?? '';
  if (!orderId) return fallback;

  try {
    const request = await prisma.orderRequestLog.findUnique({
      where: { orderId },
      select: { content: true },
    });
    const content = request?.content?.trim();
    if (content) return content;
  } catch (err) {
    console.error('[order-request] resolve content failed', err);
  }

  return fallback;
}
