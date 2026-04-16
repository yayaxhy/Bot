import { OrderStatus } from '@prisma/client';
import prisma from '../db/prisma.js';
import { resolveJinleeIdentityTx } from '../services/jinleeAccountService.js';
import type {
  ConversationState,
  OrderReference,
  ResolvedOrderTarget,
  ResolvedWorkerTarget,
  ResolutionResult,
  WorkerReference,
} from './types.js';

async function buildParticipantMatch(userId: string) {
  const identity = await resolveJinleeIdentityTx(prisma, userId);
  if (!identity) {
    return {
      OR: [{ hostId: userId }, { workerId: userId }],
    };
  }

  return {
    OR: [
      { hostId: userId },
      { workerId: userId },
      { hostJinleeId: identity.jinleeId },
    ],
  };
}

function mapOrder(order: {
  id: string;
  displayNo: number | null;
  status: OrderStatus;
  hostId: string | null;
  hostJinleeId: string | null;
  workerId: string;
  peiwanId: number;
}): ResolvedOrderTarget {
  return {
    id: order.id,
    displayNo: order.displayNo,
    status: order.status,
    hostId: order.hostId,
    hostJinleeId: order.hostJinleeId,
    workerId: order.workerId,
    peiwanId: order.peiwanId,
  };
}

function ambiguousOrderMessage(orders: ResolvedOrderTarget[], actionLabel: string) {
  const labels = orders
    .slice(0, 5)
    .map((order) => (order.displayNo != null ? `#${order.displayNo}` : order.id))
    .join('、');
  return `${actionLabel}命中了多笔订单：${labels}。请补充订单号。`;
}

export async function resolveOrderReference(params: {
  userId: string;
  reference: OrderReference | null;
  fallbackKind: 'latest_running_order' | 'latest_pending_invitation' | 'latest_order';
  actionLabel: string;
}): Promise<ResolutionResult<ResolvedOrderTarget>> {
  const { userId, fallbackKind, actionLabel } = params;
  const reference = params.reference ?? { kind: fallbackKind };
  const participantMatch = await buildParticipantMatch(userId);

  if (reference.kind === 'explicit_display_no') {
    const displayNo = Number(reference.raw);
    if (!Number.isInteger(displayNo)) {
      return { ok: false, error: { kind: 'missing', message: '订单号格式不对，请重新发一次。' } };
    }
    const order = await prisma.order.findUnique({
      where: { displayNo },
      select: {
        id: true,
        displayNo: true,
        status: true,
        hostId: true,
        hostJinleeId: true,
        workerId: true,
        peiwanId: true,
      },
    });
    if (!order) {
      return { ok: false, error: { kind: 'not_found', message: '没找到这笔订单。' } };
    }
    const isParticipant =
      order.hostId === userId || order.workerId === userId || (!!order.hostJinleeId && participantMatch.OR.some((it: any) => it.hostJinleeId === order.hostJinleeId));
    if (!isParticipant) {
      return { ok: false, error: { kind: 'not_found', message: '这笔订单不在你的可操作范围里。' } };
    }
    return { ok: true, value: mapOrder(order) };
  }

  if (reference.kind === 'explicit_id' && reference.raw) {
    const order = await prisma.order.findUnique({
      where: { id: reference.raw },
      select: {
        id: true,
        displayNo: true,
        status: true,
        hostId: true,
        hostJinleeId: true,
        workerId: true,
        peiwanId: true,
      },
    });
    if (!order) {
      return { ok: false, error: { kind: 'not_found', message: '没找到这笔订单。' } };
    }
    const isParticipant =
      order.hostId === userId || order.workerId === userId || (!!order.hostJinleeId && participantMatch.OR.some((it: any) => it.hostJinleeId === order.hostJinleeId));
    if (!isParticipant) {
      return { ok: false, error: { kind: 'not_found', message: '这笔订单不在你的可操作范围里。' } };
    }
    return { ok: true, value: mapOrder(order) };
  }

  const whereBase: Record<string, unknown> = { ...participantMatch };
  if (reference.kind === 'latest_running_order') {
    whereBase.status = OrderStatus.RUNNING;
  } else if (reference.kind === 'latest_pending_invitation') {
    whereBase.status = OrderStatus.PENDING;
    whereBase.workerId = userId;
  }

  const orders = await prisma.order.findMany({
    where: whereBase,
    orderBy: [{ createdAt: 'desc' }],
    take: reference.kind === 'latest_order' || reference.kind === 'previous_order' ? 2 : 5,
    select: {
      id: true,
      displayNo: true,
      status: true,
      hostId: true,
      hostJinleeId: true,
      workerId: true,
      peiwanId: true,
    },
  });

  if (!orders.length) {
    const emptyMessage =
      reference.kind === 'latest_pending_invitation'
        ? '你当前没有待处理的邀请。'
        : reference.kind === 'latest_running_order'
          ? '你当前没有进行中的订单。'
          : '没找到可引用的订单。';
    return { ok: false, error: { kind: 'not_found', message: emptyMessage } };
  }

  if (reference.kind === 'previous_order' && orders.length >= 2) {
    return { ok: true, value: mapOrder(orders[1]) };
  }

  if (
    (reference.kind === 'latest_running_order' || reference.kind === 'latest_pending_invitation')
    && orders.length > 1
  ) {
    return {
      ok: false,
      error: {
        kind: 'ambiguous',
        message: ambiguousOrderMessage(orders.map(mapOrder), actionLabel),
      },
    };
  }

  return { ok: true, value: mapOrder(orders[0]) };
}

async function resolveWorkerFromOrder(order: ResolvedOrderTarget | null): Promise<ResolvedWorkerTarget | null> {
  if (!order) return null;
  return {
    workerId: order.workerId,
    peiwanId: order.peiwanId,
    sourceLabel: order.displayNo != null ? `订单 #${order.displayNo}` : '最近订单',
  };
}

function startOfYesterdayLocal() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
}

function endOfYesterdayLocal() {
  const start = startOfYesterdayLocal();
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

export async function resolveWorkerReference(params: {
  userId: string;
  reference: WorkerReference | null;
  conversation: ConversationState | null;
}): Promise<ResolutionResult<ResolvedWorkerTarget>> {
  const { userId, conversation } = params;
  const reference = params.reference ?? { kind: 'current_order_worker' as const };

  if (reference.kind === 'memory_worker' && conversation?.lastWorkerId) {
    return {
      ok: true,
      value: {
        workerId: conversation.lastWorkerId,
        peiwanId: conversation.lastPeiwanId ?? null,
        sourceLabel: '最近上下文',
      },
    };
  }

  if (reference.kind === 'explicit_peiwan_id') {
    const peiwanId = Number(reference.raw);
    if (!Number.isInteger(peiwanId)) {
      return { ok: false, error: { kind: 'missing', message: '陪玩编号格式不对。' } };
    }
    const peiwan = await prisma.pEIWAN.findUnique({
      where: { PEIWANID: peiwanId },
      select: { PEIWANID: true, discordUserId: true },
    });
    if (!peiwan) {
      return { ok: false, error: { kind: 'not_found', message: `没找到编号 ${peiwanId} 的陪玩。` } };
    }
    return {
      ok: true,
      value: {
        workerId: peiwan.discordUserId,
        peiwanId: peiwan.PEIWANID,
        sourceLabel: `陪玩 ${peiwan.PEIWANID}`,
      },
    };
  }

  if (reference.kind === 'explicit_discord_user_id' && reference.raw) {
    const peiwan = await prisma.pEIWAN.findUnique({
      where: { discordUserId: reference.raw },
      select: { PEIWANID: true, discordUserId: true },
    });
    return {
      ok: true,
      value: {
        workerId: reference.raw,
        peiwanId: peiwan?.PEIWANID ?? null,
        sourceLabel: peiwan?.PEIWANID != null ? `陪玩 ${peiwan.PEIWANID}` : `<@${reference.raw}>`,
      },
    };
  }

  if (reference.kind === 'yesterday_worker') {
    const order = await prisma.order.findFirst({
      where: {
        hostId: userId,
        createdAt: {
          gte: startOfYesterdayLocal(),
          lt: endOfYesterdayLocal(),
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        displayNo: true,
        status: true,
        hostId: true,
        hostJinleeId: true,
        workerId: true,
        peiwanId: true,
      },
    });
    const mapped = order ? await resolveWorkerFromOrder(mapOrder(order)) : null;
    if (!mapped) {
      return { ok: false, error: { kind: 'not_found', message: '昨天没有找到可引用的陪玩。' } };
    }
    return { ok: true, value: mapped };
  }

  if (reference.kind === 'last_worker') {
    const order = await prisma.order.findFirst({
      where: { hostId: userId },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        displayNo: true,
        status: true,
        hostId: true,
        hostJinleeId: true,
        workerId: true,
        peiwanId: true,
      },
    });
    const mapped = order ? await resolveWorkerFromOrder(mapOrder(order)) : null;
    if (!mapped) {
      return { ok: false, error: { kind: 'not_found', message: '最近没有找到可引用的陪玩。' } };
    }
    return { ok: true, value: mapped };
  }

  const currentOrderResult = await resolveOrderReference({
    userId,
    reference: conversation?.lastOrderId
      ? { kind: 'explicit_id', raw: conversation.lastOrderId }
      : { kind: 'latest_order' },
    fallbackKind: 'latest_order',
    actionLabel: '引用陪玩',
  });

  if (currentOrderResult.ok) {
    const mapped = await resolveWorkerFromOrder(currentOrderResult.value);
    if (mapped) return { ok: true, value: mapped };
  }

  if (conversation?.lastWorkerId) {
    return {
      ok: true,
      value: {
        workerId: conversation.lastWorkerId,
        peiwanId: conversation.lastPeiwanId ?? null,
        sourceLabel: '最近上下文',
      },
    };
  }

  return { ok: false, error: { kind: 'not_found', message: '我还没定位到你说的那个陪玩。' } };
}
