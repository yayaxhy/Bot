import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  notifyWithdrawal,
  type WithdrawalNotificationPayload,
} from '../services/withdrawalNotificationService.js';
import { processWithdrawal } from '../services/withdrawalService.js';
import { performGift } from '../commands/gifting.js';
import prisma from '../db/prisma.js';
import { applyCouponDiscountForOrder, type DiscountKind } from '../services/discountService.js';
import { applyLotteryDiscountForOrder } from '../services/lotteryDiscountService.js';
import { CouponStatus, CouponType, LotteryStatus, PointShopDeliveryStatus, PointShopDeliveryType, Prisma } from '@prisma/client';
import {
  LotteryError,
  LotteryFusionError,
  POOL_LABEL,
  PRIZE_NAMES,
  RENAME_CARD_NAMES,
  performLotteryFusion,
} from '../services/lotteryService.js';
import { applyCommissionBuff, applyFlowBuff, applySpendBuff } from '../services/buffService.js';
import { revertGiftByIndividualTx } from '../services/revertGiftService.js';
import { RENAME_CARD_COUPON_TYPES, VOUCHER_COUPON_TYPE_BY_PRIZE } from '../config/voucherCatalog.js';
import {
  ensureJinleeIdentityForDiscordTx,
  isJinleeIdentityNotFoundError,
  requireJinleeIdentityTx,
} from '../services/jinleeAccountService.js';
import { syncAllPeiwanRoles, syncPeiwanRolesForDiscordUser } from '../services/peiwanRoleSyncService.js';
import { sendPeiwanNotification } from '../services/peiwanWatcher.js';
import { syncSpentRolesForMember } from '../services/spentRoleService.js';
import {
  announceLotteryFusionWebSuccess,
  sendLotteryFusionSuccessDm,
} from '../services/lotteryFusionNotificationService.js';
import { isWebLotteryFusionRequestId } from '../services/lotteryFusionBotService.js';

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
const INTERNAL_PORT = Number(process.env.INTERNAL_API_PORT ?? 3710);
const MAX_BODY_SIZE = Number(process.env.INTERNAL_API_MAX_BODY ?? 1024 * 32);
const INTERNAL_API_ORIGIN = process.env.INTERNAL_API_ORIGIN ?? '*';
const INTERNAL_API_ALLOWED_HEADERS =
  process.env.INTERNAL_API_ALLOWED_HEADERS ?? 'Content-Type, X-Internal-Token';
const INTERNAL_API_ALLOWED_METHODS = 'GET, POST, OPTIONS';
const RENAME_NOTIFY_CHANNEL_ID = process.env.RENAME_NOTIFY_CHANNEL_ID ?? '1446819752692416542';
const RENAME_NOTIFY_USER_ID = process.env.RENAME_NOTIFY_USER_ID ?? '1421651539247894549';
const INTERNAL_ALLOWED_IPS = (process.env.INTERNAL_ALLOWED_IPS ?? '43.131.41.173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_NOTIFY_USER_ID = '1421651539247894549';
const ADMIN_TOKEN_COOKIE = 'internal_admin_token';
const PROFILE_PERSONALISATION_URL =
  process.env.PROFILE_PERSONALISATION_URL ?? 'https://jinleeclub.vip/profile?tab=profile-personalisation';

let serverInstance: http.Server | null = null;
const withdrawalNotificationQueue = new Map<string, Promise<{ statusCode: number; body: Record<string, unknown> }>>();

function applyCorsHeaders(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', INTERNAL_API_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', INTERNAL_API_ALLOWED_HEADERS);
  res.setHeader('Access-Control-Allow-Methods', INTERNAL_API_ALLOWED_METHODS);
}

function isIpAllowed(req: IncomingMessage): boolean {
  if (!INTERNAL_ALLOWED_IPS.length) return true;
  const remote = req.socket.remoteAddress ?? '';
  // handle IPv6-mapped IPv4 addresses like ::ffff:43.131.41.173
  const normalized = remote.replace('::ffff:', '');
  return INTERNAL_ALLOWED_IPS.includes(normalized) || INTERNAL_ALLOWED_IPS.includes(remote);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_SIZE) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  applyCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

const getIdentityErrorResponse = (error: unknown) => {
  if (isJinleeIdentityNotFoundError(error)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: 'user_not_found',
        userId: error.requestedId,
      },
    };
  }

  return null;
};

function redirect(res: ServerResponse, location: string, statusCode = 303) {
  applyCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Location', location);
  res.end();
}

function parseCookies(req: IncomingMessage) {
  const header = req.headers.cookie ?? '';
  const cookies: Record<string, string> = {};
  for (const entry of header.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getRequestToken(req: IncomingMessage, url?: URL) {
  const headerToken = req.headers['x-internal-token'];
  if (typeof headerToken === 'string' && headerToken) return headerToken;
  const cookies = parseCookies(req);
  if (cookies[ADMIN_TOKEN_COOKIE]) return cookies[ADMIN_TOKEN_COOKIE];
  return url?.searchParams.get('token') ?? '';
}

function ensureInternalAccess(req: IncomingMessage, res: ServerResponse, url?: URL): boolean {
  if (!isIpAllowed(req)) {
    console.warn('[internal-api] rejected request from disallowed IP', req.socket.remoteAddress);
    sendJson(res, 403, { ok: false, error: 'forbidden_ip' });
    return false;
  }

  if (!INTERNAL_TOKEN) return true;

  const token = getRequestToken(req, url);
  if (token !== INTERNAL_TOKEN) {
    console.warn('[internal-api] rejected unauthorized request');
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return false;
  }

  if (url?.searchParams.get('token') === INTERNAL_TOKEN) {
    res.setHeader('Set-Cookie', `${ADMIN_TOKEN_COOKIE}=${encodeURIComponent(INTERNAL_TOKEN)}; Path=/; HttpOnly; SameSite=Lax`);
  }

  return true;
}

async function parseJsonBody(req: IncomingMessage, res: ServerResponse): Promise<any | null> {
  const url = req.url ? new URL(req.url, 'http://localhost') : undefined;
  if (!ensureInternalAccess(req, res, url)) return null;

  let raw = '';
  try {
    raw = await readBody(req);
  } catch (err) {
    console.error('[internal-api] failed to read body', err);
    sendJson(res, 413, { ok: false, error: 'payload_too_large' });
    return null;
  }

  let payload: any;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid_json' });
    return null;
  }

  return payload;
}

async function resolveDiscordId(input: { discordId?: string | null; peiwanId?: number | null }) {
  if (input.discordId) return input.discordId;
  if (input.peiwanId != null) {
    const row = await prisma.pEIWAN.findUnique({
      where: { PEIWANID: Number(input.peiwanId) },
      select: { discordUserId: true },
    });
    return row?.discordUserId ?? null;
  }
  return null;
}

async function consumeCouponRecordTx(
  tx: Prisma.TransactionClient,
  params: {
    couponId: string;
    jinleeId: string;
    couponType: CouponType;
    now: Date;
    requestId?: string;
    consumeTargetDiscordUserId: string | null;
    consumeTargetJinleeId: string;
  },
): Promise<boolean> {
  const { couponId, jinleeId, couponType, now, requestId, consumeTargetDiscordUserId, consumeTargetJinleeId } = params;
  const result = await tx.coupon.updateMany({
    where: {
      id: couponId,
      jinleeId,
      type: couponType,
      status: CouponStatus.ACTIVE,
      expiresAt: { gt: now },
      consumedAt: null,
      orderId: null,
    },
    data: {
      status: CouponStatus.USED,
      consumedAt: now,
      consumeAmount: 0,
      consumeTargetId: consumeTargetDiscordUserId,
      consumeTargetJinleeId: consumeTargetJinleeId,
      orderId: requestId ?? null,
    },
  });
  return result.count === 1;
}

async function consumePointShopVoucherRecordTx(
  tx: Prisma.TransactionClient,
  params: {
    grantId: string;
    jinleeId: string;
    couponType: CouponType;
    now: Date;
    requestId?: string;
    consumeTargetDiscordUserId: string | null;
    consumeTargetJinleeId: string;
  },
): Promise<boolean> {
  const { grantId, jinleeId, couponType, now, requestId, consumeTargetDiscordUserId, consumeTargetJinleeId } = params;
  const result = await tx.pointShopGrant.updateMany({
    where: {
      id: grantId,
      jinleeId,
      deliveryType: PointShopDeliveryType.COUPON,
      deliveryStatus: PointShopDeliveryStatus.DELIVERED,
      couponType,
      couponStatus: CouponStatus.ACTIVE,
      consumedAt: null,
      consumeOrderId: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: {
      couponStatus: CouponStatus.USED,
      consumedAt: now,
      consumeAmount: 0,
      consumeTargetId: consumeTargetDiscordUserId,
      consumeTargetJinleeId: consumeTargetJinleeId,
      consumeOrderId: requestId ?? null,
    },
  });
  return result.count === 1;
}

async function consumeLotteryVoucherRecordTx(
  tx: Prisma.TransactionClient,
  params: {
    voucherId: string;
    jinleeId: string;
    prizeName: string;
    now: Date;
    requestId?: string;
    consumeTargetDiscordUserId: string | null;
    consumeTargetJinleeId: string;
  },
): Promise<boolean> {
  const { voucherId, jinleeId, prizeName, now, requestId, consumeTargetDiscordUserId, consumeTargetJinleeId } = params;
  const result = await tx.lotteryDraw.updateMany({
    where: {
      id: voucherId,
      jinleeId,
      status: LotteryStatus.UNUSED,
      consumeAt: null,
      expiresAt: { gt: now },
      prize: { name: prizeName },
    },
    data: {
      status: LotteryStatus.USED,
      consumeAt: now,
      consumeTargetId: consumeTargetDiscordUserId,
      consumeTargetJinleeId: consumeTargetJinleeId,
      ...(requestId ? { requestId } : {}),
    },
  });
  return result.count === 1;
}

async function consumeVoucher(
  params: {
    userId: string;
    prizeName: string;
    requestId?: string;
    voucherId?: string;
    consumeTarget?: {
      discordUserId: string | null;
      jinleeId: string;
    };
  },
  tx: import('@prisma/client').Prisma.TransactionClient
  ): Promise<{ voucherId: string } | null> {
  const { userId, prizeName, requestId, voucherId, consumeTarget } = params;
  const now = new Date();
  const couponType = VOUCHER_COUPON_TYPE_BY_PRIZE[prizeName];
  const userIdentity = await requireJinleeIdentityTx(tx, userId);
  const consumeTargetDiscordUserId = consumeTarget?.discordUserId ?? userIdentity.discordUserId ?? null;
  const consumeTargetJinleeId = consumeTarget?.jinleeId ?? userIdentity.jinleeId;

  if (couponType) {
    await tx.coupon.updateMany({
      where: {
        jinleeId: userIdentity.jinleeId,
        type: couponType,
        status: CouponStatus.ACTIVE,
        expiresAt: { lte: now },
      },
      data: { status: CouponStatus.EXPIRED },
    });

      if (voucherId) {
        if (
          await consumeCouponRecordTx(tx, {
            couponId: voucherId,
            jinleeId: userIdentity.jinleeId,
            couponType,
            now,
            requestId,
            consumeTargetDiscordUserId,
            consumeTargetJinleeId,
          })
        ) {
          return { voucherId };
        }
      } else {
        while (true) {
          const coupon = await tx.coupon.findFirst({
            where: {
              jinleeId: userIdentity.jinleeId,
              type: couponType,
              status: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
            },
            select: { id: true },
            orderBy: [{ expiresAt: 'asc' }, { issuedAt: 'asc' }, { id: 'asc' }],
          });
          if (!coupon) break;
          if (
            await consumeCouponRecordTx(tx, {
              couponId: coupon.id,
              jinleeId: userIdentity.jinleeId,
              couponType,
              now,
              requestId,
              consumeTargetDiscordUserId,
              consumeTargetJinleeId,
            })
          ) {
            return { voucherId: coupon.id };
          }
        }
      }

      try {
      await tx.pointShopGrant.updateMany({
        where: {
          jinleeId: userIdentity.jinleeId,
          deliveryType: PointShopDeliveryType.COUPON,
          deliveryStatus: PointShopDeliveryStatus.DELIVERED,
          couponType,
          couponStatus: CouponStatus.ACTIVE,
          expiresAt: { lte: now },
        },
        data: { couponStatus: CouponStatus.EXPIRED },
      });

        if (voucherId) {
          if (
            await consumePointShopVoucherRecordTx(tx, {
              grantId: voucherId,
              jinleeId: userIdentity.jinleeId,
              couponType,
              now,
              requestId,
              consumeTargetDiscordUserId,
              consumeTargetJinleeId,
            })
          ) {
            return { voucherId };
          }
        } else {
          while (true) {
            const pointShopGrant = await tx.pointShopGrant.findFirst({
              where: {
                jinleeId: userIdentity.jinleeId,
                deliveryType: PointShopDeliveryType.COUPON,
                deliveryStatus: PointShopDeliveryStatus.DELIVERED,
                couponType,
                couponStatus: CouponStatus.ACTIVE,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
              select: { id: true },
              orderBy: [{ expiresAt: 'asc' }, { issuedAt: 'asc' }, { id: 'asc' }],
            });
            if (!pointShopGrant) break;
            if (
              await consumePointShopVoucherRecordTx(tx, {
                grantId: pointShopGrant.id,
                jinleeId: userIdentity.jinleeId,
                couponType,
                now,
                requestId,
                consumeTargetDiscordUserId,
                consumeTargetJinleeId,
              })
            ) {
              return { voucherId: pointShopGrant.id };
            }
          }
        }
      } catch (error) {
        console.warn('[internal-api] consume point shop voucher fallback failed', error);
    }
  }

  await tx.lotteryDraw.updateMany({
    where: {
      jinleeId: userIdentity.jinleeId,
      status: LotteryStatus.UNUSED,
      expiresAt: { lte: now },
      prize: { name: prizeName },
    },
    data: { status: LotteryStatus.EXPIRED },
  });

    if (voucherId) {
      if (
        await consumeLotteryVoucherRecordTx(tx, {
          voucherId,
          jinleeId: userIdentity.jinleeId,
          prizeName,
          now,
          requestId,
          consumeTargetDiscordUserId,
          consumeTargetJinleeId,
        })
      ) {
        return { voucherId };
      }
      return null;
    }

    while (true) {
      const voucher = await tx.lotteryDraw.findFirst({
        where: {
          jinleeId: userIdentity.jinleeId,
          status: LotteryStatus.UNUSED,
          expiresAt: { gt: now },
          prize: { name: prizeName },
        },
        select: { id: true },
        orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      if (!voucher) return null;
      if (
        await consumeLotteryVoucherRecordTx(tx, {
          voucherId: voucher.id,
          jinleeId: userIdentity.jinleeId,
          prizeName,
          now,
          requestId,
          consumeTargetDiscordUserId,
          consumeTargetJinleeId,
        })
      ) {
        return { voucherId: voucher.id };
      }
    }
  }

const normalizeVoucherId = (payload: any): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  if (payload.voucherId) return payload.voucherId;
  if (payload.lotteryId) return payload.lotteryId;
  if (payload.lotteryVoucherId) return payload.lotteryVoucherId;
  if (payload.id) return payload.id;
  // case-insensitive fallback
  for (const [k, v] of Object.entries(payload)) {
    const key = k.toLowerCase();
    if (key === 'voucherid' || key === 'lotteryid' || key === 'lotteryvoucherid') {
      return v as string;
    }
  }
  return undefined;
};

async function notifyChannel(message: string) {
  try {
    const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
    if (!client || !RENAME_NOTIFY_CHANNEL_ID) {
      console.warn('[internal-api] notifyChannel skipped (client missing or channel id missing)');
      return;
    }
    const channel = await client.channels.fetch(RENAME_NOTIFY_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as any).send({ content: message, allowedMentions: { parse: ['users'] } });
      console.log('[internal-api] notifyChannel sent', { channelId: RENAME_NOTIFY_CHANNEL_ID });
    } else {
      console.warn('[internal-api] notifyChannel failed to fetch text channel', { channelId: RENAME_NOTIFY_CHANNEL_ID });
    }
  } catch (err) {
    console.error('[internal-api] notify channel failed:', err);
  }
}

type InternalWithdrawalNotificationPayload = {
  userDiscordId?: string;
  amount?: number | string;
  requestedAt?: string | number | Date;
  withdrawalId?: string;
  note?: string;
  currency?: string;
  remainingIncome?: number | string;
};

async function deliverWithdrawalNotification(
  rawPayload: InternalWithdrawalNotificationPayload
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const withdrawalId = rawPayload.withdrawalId?.toString().trim() || undefined;
  let payload: InternalWithdrawalNotificationPayload = { ...rawPayload, withdrawalId };

  if (withdrawalId) {
    const record = await prisma.withdraw.findUnique({
      where: { id: withdrawalId },
    });

    if (!record) {
      return { statusCode: 404, body: { ok: false, error: 'withdrawal_not_found' } };
    }
    if (record.notifiedAt) {
      return { statusCode: 200, body: { ok: true, duplicate: true, withdrawalId } };
    }

    payload = {
      ...payload,
      ...(record.discordId ? { userDiscordId: record.discordId } : {}),
      amount: record.amount.toString(),
      requestedAt: record.createdAt,
      withdrawalId: record.id,
      note: record.method,
    };
  }

  if (!payload.userDiscordId || payload.amount == null) {
    return { statusCode: 400, body: { ok: false, error: 'missing_fields' } };
  }

  const notificationResult = await notifyWithdrawal(payload as WithdrawalNotificationPayload);
  if (!notificationResult.delivered) {
    return {
      statusCode: 502,
      body: {
        ok: false,
        error: 'notification_failed',
        withdrawalId,
        ...notificationResult,
      },
    };
  }

  if (withdrawalId) {
    await prisma.withdraw.update({
      where: { id: withdrawalId },
      data: { notifiedAt: new Date() },
    });
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      withdrawalId,
      duplicate: false,
      ...notificationResult,
    },
  };
}

function scheduleWithdrawalNotification(
  payload: InternalWithdrawalNotificationPayload
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const withdrawalId = payload.withdrawalId?.toString().trim();
  if (!withdrawalId) {
    return deliverWithdrawalNotification(payload);
  }

  const previous =
    withdrawalNotificationQueue.get(withdrawalId) ??
    Promise.resolve({ statusCode: 200, body: { ok: true } });
  const current = previous
    .catch(() => undefined)
    .then(() => deliverWithdrawalNotification({ ...payload, withdrawalId }));

  withdrawalNotificationQueue.set(withdrawalId, current);
  return current.finally(() => {
    if (withdrawalNotificationQueue.get(withdrawalId) === current) {
      withdrawalNotificationQueue.delete(withdrawalId);
    }
  });
}

async function handleWithdrawal(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  try {
    const response = await scheduleWithdrawalNotification(payload);
    sendJson(res, response.statusCode, response.body);
  } catch (err) {
    console.error('[internal-api] notifyWithdrawal failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleProcessWithdrawal(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  if (!payload?.userDiscordId || payload.amount == null) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
    return;
  }

  try {
    const result = await processWithdrawal({
      userDiscordId: payload.userDiscordId,
      amount: payload.amount,
      operatorDiscordId: payload.operatorDiscordId,
      note: payload.note,
    });

    try {
      await notifyWithdrawal({
        userDiscordId: payload.userDiscordId,
        amount: result.amount,
        requestedAt: payload.requestedAt,
        withdrawalId: result.transactionId,
        note: payload.note,
        remainingIncome: result.incomeAfter,
      });
    } catch (err) {
      console.error('[internal-api] notifyWithdrawal after process failed', err);
    }

    sendJson(res, 200, { ok: true, result });
  } catch (err: any) {
    console.error('[internal-api] processWithdrawal error', err);
    const message = err instanceof Error ? err.message : 'internal_error';
    const statusCode =
      message.includes('余额不足') ||
      message.includes('未找到') ||
      message.includes('金额')
        ? 400
        : 500;
    sendJson(res, statusCode, { ok: false, error: message });
  }
}

async function handleGift(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { giverId, receiverId, giftName, quantity, anonymous, lotteryId, couponId, requestId } = payload ?? {};
  if (!giverId || !receiverId || !giftName || !quantity) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
    return;
  }
  if (!lotteryId && !couponId) {
    sendJson(res, 400, { ok: false, error: 'missing_voucher' });
    return;
  }

  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) {
    sendJson(res, 503, { ok: false, error: 'client_not_ready' });
    return;
  }

  try {
    const result = await performGift(client, prisma, {
      giverId,
      receiverId,
      giftName,
      quantity: Number(quantity),
      anonymous: !!anonymous,
      lotteryVoucherId: lotteryId,
      couponVoucherId: couponId,
      voucherRequestId: requestId,
    });
    sendJson(res, 200, { ok: true, result });
  } catch (err: any) {
    console.error('[internal-api] gift failed', err);
    const message = err?.message ?? 'internal_error';
    const statusCode =
      typeof message === 'string' &&
      (
        message.includes('余额不足') ||
        message.includes('仅限客服账号打赏') ||
        message.includes('不支持代打赏') ||
        message.includes('礼物不存在') ||
        message.includes('该礼物已经下架') ||
        message.includes('数量必须大于 0') ||
        message.includes('金额必须大于 0') ||
        message.includes('不能给自己打赏')
      )
        ? 400
        : 500;
    sendJson(res, statusCode, { ok: false, error: message });
  }
}

async function handleCustomVoucherUse(
  req: IncomingMessage,
  res: ServerResponse,
  prizeName: string,
  label: string,
  notifyTextBuilder: (userId: string) => string,
  notifyUserId?: string
) {
  console.log('[internal-api] custom voucher request', {
    path: req.url,
    prizeName,
    ip: req.socket.remoteAddress,
  });

  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { userId } = payload ?? {};
  const voucherId = normalizeVoucherId(payload);
  if (!userId) {
    sendJson(res, 400, { ok: false, error: 'missing_user' });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      return consumeVoucher({ userId, prizeName, voucherId }, tx);
    });

    if (!result) {
      console.warn('[internal-api] custom voucher not found or expired', { prizeName, userId });
      sendJson(res, 404, { ok: false, error: 'no_voucher' });
      return;
    }

    await notifyChannel(notifyTextBuilder(userId));
    if (notifyUserId) {
      try {
        const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
        if (client) {
          const u = await client.users.fetch(notifyUserId).catch(() => null);
          if (u) await u.send({ content: notifyTextBuilder(userId) });
        }
      } catch (err) {
        console.error('[internal-api] custom voucher dm failed', err);
      }
    }
    console.log('[internal-api] custom voucher consumed', { prizeName, userId, voucherId: result.voucherId });
    sendJson(res, 200, { ok: true, voucherId: result.voucherId });
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    console.error('[internal-api] custom voucher use failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleCommissionBoost(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const targetDiscordId = await resolveDiscordId({
    discordId: payload?.targetDiscordId,
    peiwanId: payload?.peiwanId,
  });
  const userId = targetDiscordId;
  if (!userId) {
    sendJson(res, 400, { ok: false, error: 'missing_target' });
    return;
  }
  const voucherId = normalizeVoucherId(payload);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const voucher = await consumeVoucher(
        {
          userId: payload?.userId ?? userId,
          prizeName: PRIZE_NAMES.COMMISSION_MINUS1_VOUCHER,
          voucherId,
        },
        tx
      );
      if (!voucher) return null;
      const boost = await applyCommissionBuff(tx, userId);
      return {
        voucherId: voucher.voucherId,
        expiresAt: boost.expiresAt,
        commissionRate: boost.commissionRate?.toString(),
      };
    });

    if (!result) {
      sendJson(res, 404, { ok: false, error: 'no_voucher' });
      return;
    }

    await notifyChannel(`<@${ADMIN_NOTIFY_USER_ID}>, 用户 <@${userId}> 使用了抽成降1%券`);
    sendJson(res, 200, {
      ok: true,
      voucherId: result.voucherId,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    console.error('[internal-api] commission boost failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleDoubleFlow(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const targetDiscordId = await resolveDiscordId({
    discordId: payload?.targetDiscordId,
    peiwanId: payload?.peiwanId,
  });
  const userId = targetDiscordId;
  if (!userId) {
    sendJson(res, 400, { ok: false, error: 'missing_target' });
    return;
  }
  const voucherId = normalizeVoucherId(payload);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const voucher = await consumeVoucher(
        {
          userId: payload?.userId ?? userId,
          prizeName: PRIZE_NAMES.DOUBLE_FLOW_5000_VOUCHER,
          voucherId,
        },
        tx
      );
      if (!voucher) return null;
      const boost = await applyFlowBuff(tx, userId);
      return { voucherId: voucher.voucherId, expiresAt: boost.expiresAt, remaining: boost.remaining };
    });

    if (!result) {
      sendJson(res, 404, { ok: false, error: 'no_voucher' });
      return;
    }

    await notifyChannel(`<@${ADMIN_NOTIFY_USER_ID}>, 用户 <@${userId}> 使用了双倍流水5000券`);
    sendJson(res, 200, {
      ok: true,
      voucherId: result.voucherId,
      expiresAt: result.expiresAt.toISOString(),
      remaining: result.remaining.toString(),
    });
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    console.error('[internal-api] double flow boost failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleDoubleSpend(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const targetDiscordId = await resolveDiscordId({
    discordId: payload?.targetDiscordId,
    peiwanId: payload?.peiwanId,
  });
  const userId = targetDiscordId;
  if (!userId) {
    sendJson(res, 400, { ok: false, error: 'missing_target' });
    return;
  }
  const voucherId = normalizeVoucherId(payload);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const voucher = await consumeVoucher(
        {
          userId: payload?.userId ?? userId,
          prizeName: PRIZE_NAMES.DOUBLE_SPEND_5000_VOUCHER,
          voucherId,
        },
        tx
      );
      if (!voucher) return null;
      const boost = await applySpendBuff(tx, userId);
      return { voucherId: voucher.voucherId, expiresAt: boost.expiresAt, remaining: boost.remaining };
    });

    if (!result) {
      sendJson(res, 404, { ok: false, error: 'no_voucher' });
      return;
    }

    await notifyChannel(`<@${ADMIN_NOTIFY_USER_ID}>, 用户 <@${userId}> 使用了双倍消费5000券`);
    sendJson(res, 200, {
      ok: true,
      voucherId: result.voucherId,
      expiresAt: result.expiresAt.toISOString(),
      remaining: result.remaining.toString(),
    });
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    console.error('[internal-api] double spend boost failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handlePeiwanReviewVoucher(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const reviewerId = payload?.userId != null ? String(payload.userId).trim() : '';
  const requestId = payload?.requestId != null ? String(payload.requestId).trim() : '';
  const contentRaw = payload?.content?.toString?.() ?? '';
  const content = contentRaw.trim();
  const voucherId = normalizeVoucherId(payload);
  const targetDiscordId = await resolveDiscordId({
    discordId: payload?.targetDiscordId,
    peiwanId: payload?.peiwanId,
  });

  if (!reviewerId || !targetDiscordId || !content) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
    return;
  }
  if (content.length > 500) {
    sendJson(res, 400, { ok: false, error: 'review_too_long' });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const reviewerIdentity = await requireJinleeIdentityTx(tx, reviewerId);
      if (!reviewerIdentity.discordUserId) {
        return { code: 'discord_required' as const };
      }

      const targetPeiwan = await tx.pEIWAN.findUnique({
        where: { discordUserId: targetDiscordId },
        select: { PEIWANID: true, discordUserId: true, serverDisplayName: true },
      });
      if (!targetPeiwan?.discordUserId) {
        return { code: 'target_not_peiwan' as const };
      }
      const targetIdentity = await ensureJinleeIdentityForDiscordTx(tx, targetDiscordId);

      const [reviewerMember, peiwanMember] = await Promise.all([
        tx.member.findUnique({
          where: { discordUserId: reviewerIdentity.discordUserId },
          select: { serverDisplayName: true },
        }),
        tx.member.findUnique({
          where: { discordUserId: targetDiscordId },
          select: { serverDisplayName: true },
        }),
      ]);

      const voucher = await consumeVoucher(
        {
          userId: reviewerId,
          prizeName: PRIZE_NAMES.PEIWAN_REVIEW_VOUCHER,
          requestId,
          voucherId,
          consumeTarget: {
            discordUserId: targetDiscordId,
            jinleeId: targetIdentity.jinleeId,
          },
        },
        tx
      );
      if (!voucher) return { code: 'no_voucher' as const };

      const review = await tx.peiwanReview.create({
        data: {
          sourceGrantId: voucher.voucherId,
          reviewerDiscordId: reviewerIdentity.discordUserId,
          reviewerName: reviewerMember?.serverDisplayName ?? null,
          peiwanDiscordId: targetDiscordId,
          peiwanName: peiwanMember?.serverDisplayName ?? targetPeiwan.serverDisplayName ?? null,
          peiwanId: targetPeiwan.PEIWANID ?? null,
          content,
        },
      });

      return {
        code: 'ok' as const,
        reviewId: review.id,
        reviewerName: reviewerMember?.serverDisplayName?.trim() ?? '',
      };
    });

    if (result.code === 'no_voucher') {
      sendJson(res, 404, { ok: false, error: 'no_voucher' });
      return;
    }
    if (result.code === 'target_not_peiwan') {
      sendJson(res, 404, { ok: false, error: 'target_not_peiwan' });
      return;
    }
    if (result.code === 'discord_required') {
      sendJson(res, 400, { ok: false, error: 'discord_required' });
      return;
    }

    try {
      const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
      if (client) {
        const targetUser = await client.users.fetch(targetDiscordId).catch(() => null);
        if (targetUser) {
          const reviewerName = result.reviewerName || reviewerId;
          await targetUser.send(
            `${reviewerName}老板给你新增一条评语，请到个人主页的个性化里面查看并添加到名片上面吧\n${PROFILE_PERSONALISATION_URL}`
          );
        }
      }
    } catch (err) {
      console.error('[internal-api] peiwan review voucher dm failed', err);
    }

    sendJson(res, 200, { ok: true, reviewId: result.reviewId });
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    console.error('[internal-api] peiwan review voucher failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleDiscount(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { orderId, userId, kind, couponId, lotteryId, prizeName } = payload ?? {};
  if (!orderId || !userId || !kind) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
    return;
  }

  const discountKind = kind as DiscountKind;
  if (discountKind !== 'coupon' && discountKind !== 'lottery') {
    sendJson(res, 400, { ok: false, error: 'invalid_kind' });
    return;
  }

  try {
    const result =
      discountKind === 'coupon'
        ? await applyCouponDiscountForOrder({
            orderId,
            userId,
            couponId,
          })
        : await applyLotteryDiscountForOrder({
            orderId,
            userId,
            lotteryId,
            prizeName,
          });

    if (result.status !== 'applied') {
      const codeMap: Record<string, number> = {
        order_not_found: 404,
        not_order_host: 403,
        order_not_ended: 400,
        already_used: 409,
        no_coupon: 400,
        no_lottery: 400,
        no_fee: 400,
        insufficient_data: 400,
      };
      const statusCode = codeMap[result.status] ?? 400;
      sendJson(res, statusCode, { ok: false, error: result.status });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      amount: result.consumeAmount?.toString?.() ?? null,
      kind: result.kind,
    });
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    console.error('[internal-api] discount failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleLotteryFusion(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const userId =
    typeof payload?.jinleeId === 'string' && payload.jinleeId.trim()
      ? payload.jinleeId.trim()
      : typeof payload?.userId === 'string' && payload.userId.trim()
        ? payload.userId.trim()
        : '';
  const sourceIds = Array.isArray(payload?.sourceIds)
    ? payload.sourceIds.map((value: unknown) => String(value ?? '').trim()).filter(Boolean)
    : Array.isArray(payload?.lotteryIds)
      ? payload.lotteryIds.map((value: unknown) => String(value ?? '').trim()).filter(Boolean)
    : [];
  const requestId =
    typeof payload?.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : undefined;

  if (!userId || sourceIds.length === 0) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
    return;
  }

  try {
    const result = await performLotteryFusion({
      userId,
      sourceIds,
      requestId,
    });
    sendJson(res, 200, {
      ok: true,
      result: {
        drawId: result.drawId,
        prizeName: result.prize.name,
        prizeType: result.prize.type,
        pool: result.pool,
        poolLabel: POOL_LABEL[result.pool],
        imageUrl: result.prize.imageUrl,
        expiresAt: result.expiresAt?.toISOString() ?? null,
        sourceIds: result.sourceIds,
      },
    });

    const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
    if (client) {
      void requireJinleeIdentityTx(prisma, userId)
        .then(async (identity) => {
          await sendLotteryFusionSuccessDm({
            client,
            discordUserId: identity.discordUserId,
            prizeName: result.prize.name,
          });

          if (isWebLotteryFusionRequestId(requestId)) {
            await announceLotteryFusionWebSuccess({
              client,
              discordUserId: identity.discordUserId,
              prizeName: result.prize.name,
              fallbackUserLabel: `金狸ID ${identity.jinleeId}`,
            });
          }
        })
        .catch((notifyError) => {
          console.error('[internal-api] lottery fusion notify failed', notifyError);
        });
    }
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    if (err instanceof LotteryFusionError) {
      const statusCode =
        err.code === 'SOURCE_ITEM_UNAVAILABLE'
          ? 409
          : err.code === 'NO_SOURCE_ITEM'
            ? 404
            : 400;
      sendJson(res, statusCode, { ok: false, error: err.code });
      return;
    }
    if (err instanceof LotteryError) {
      if (err.code === 'NO_FALLBACK_PRIZE' || err.code === 'NO_PRIZE_AVAILABLE') {
        sendJson(res, 409, { ok: false, error: err.code });
        return;
      }
    }
    console.error('[internal-api] lottery fusion failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleRenameCard(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { userId } = payload ?? {};
  const voucherId = normalizeVoucherId(payload);
  if (!userId) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
    return;
  }

  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) {
    sendJson(res, 503, { ok: false, error: 'client_not_ready' });
    return;
  }

  const now = new Date();

  let result:
    | { used: true; prizeName: string; discordUserId: string | null }
    | { used: false; error: 'discord_required' }
    | { used: false };
  try {
    result = await prisma.$transaction(async (tx) => {
      const userIdentity = await requireJinleeIdentityTx(tx, String(userId));
      if (!userIdentity.discordUserId) {
        return { used: false as const, error: 'discord_required' as const };
      }
      const couponTypes = RENAME_CARD_COUPON_TYPES;

      await tx.coupon.updateMany({
        where: {
          jinleeId: userIdentity.jinleeId,
          type: { in: couponTypes },
          status: CouponStatus.ACTIVE,
          expiresAt: { lte: now },
        },
        data: { status: CouponStatus.EXPIRED },
      });

      await tx.pointShopGrant.updateMany({
        where: {
          jinleeId: userIdentity.jinleeId,
          deliveryType: PointShopDeliveryType.COUPON,
          deliveryStatus: PointShopDeliveryStatus.DELIVERED,
          couponType: { in: couponTypes },
          couponStatus: CouponStatus.ACTIVE,
          expiresAt: { lte: now },
        },
        data: { couponStatus: CouponStatus.EXPIRED },
      });

      await tx.lotteryDraw.updateMany({
        where: {
          jinleeId: userIdentity.jinleeId,
          status: LotteryStatus.UNUSED,
          expiresAt: { lte: now },
          prize: { name: { in: RENAME_CARD_NAMES } },
        },
        data: { status: LotteryStatus.EXPIRED },
      });

      const consumeCouponById = async (targetId: string) => {
        const result = await tx.coupon.updateMany({
          where: {
            id: targetId,
            jinleeId: userIdentity.jinleeId,
            type: { in: couponTypes },
            status: CouponStatus.ACTIVE,
            expiresAt: { gt: now },
          },
          data: {
            status: CouponStatus.USED,
            consumedAt: now,
            consumeAmount: 0,
            consumeTargetId: userIdentity.discordUserId,
            consumeTargetJinleeId: userIdentity.jinleeId,
          },
        });
        return result.count === 1;
      };

      const consumePointShopById = async (targetId: string) => {
        const result = await tx.pointShopGrant.updateMany({
          where: {
            id: targetId,
            jinleeId: userIdentity.jinleeId,
            deliveryType: PointShopDeliveryType.COUPON,
            deliveryStatus: PointShopDeliveryStatus.DELIVERED,
            couponType: { in: couponTypes },
            couponStatus: CouponStatus.ACTIVE,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          data: {
            couponStatus: CouponStatus.USED,
            consumedAt: now,
            consumeAmount: 0,
            consumeTargetId: userIdentity.discordUserId,
            consumeTargetJinleeId: userIdentity.jinleeId,
          },
        });
        return result.count > 0;
      };

      if (voucherId) {
        if (await consumeCouponById(voucherId)) {
          return { used: true as const, prizeName: '改名卡', discordUserId: userIdentity.discordUserId };
        }
        if (await consumePointShopById(voucherId)) {
          return { used: true as const, prizeName: '改名卡', discordUserId: userIdentity.discordUserId };
        }
      } else {
        const [couponCandidate, pointShopCandidate] = await Promise.all([
          tx.coupon.findFirst({
            where: {
              jinleeId: userIdentity.jinleeId,
              type: { in: couponTypes },
              status: CouponStatus.ACTIVE,
              expiresAt: { gt: now },
            },
            select: { id: true, issuedAt: true },
            orderBy: { issuedAt: 'asc' },
          }),
          tx.pointShopGrant.findFirst({
            where: {
              jinleeId: userIdentity.jinleeId,
              deliveryType: PointShopDeliveryType.COUPON,
              deliveryStatus: PointShopDeliveryStatus.DELIVERED,
              couponType: { in: couponTypes },
              couponStatus: CouponStatus.ACTIVE,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { id: true, issuedAt: true },
            orderBy: { issuedAt: 'asc' },
          }),
        ]);

        const pointShopRow = pointShopCandidate;
        if (couponCandidate && pointShopRow) {
          if (couponCandidate.issuedAt <= pointShopRow.issuedAt) {
            if (await consumeCouponById(couponCandidate.id)) {
              return { used: true as const, prizeName: '改名卡', discordUserId: userIdentity.discordUserId };
            }
          } else if (await consumePointShopById(pointShopRow.id)) {
            return { used: true as const, prizeName: '改名卡', discordUserId: userIdentity.discordUserId };
          }
        } else if (couponCandidate) {
          if (await consumeCouponById(couponCandidate.id)) {
            return { used: true as const, prizeName: '改名卡', discordUserId: userIdentity.discordUserId };
          }
        } else if (pointShopRow) {
          if (await consumePointShopById(pointShopRow.id)) {
            return { used: true as const, prizeName: '改名卡', discordUserId: userIdentity.discordUserId };
          }
        }
      }

      const consumeLotteryCard = async (targetVoucherId?: string) => {
        while (true) {
          const card = targetVoucherId
            ? await tx.lotteryDraw.findFirst({
                where: {
                  id: targetVoucherId,
                  jinleeId: userIdentity.jinleeId,
                  status: LotteryStatus.UNUSED,
                  consumeAt: null,
                  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                  prize: { name: { in: RENAME_CARD_NAMES } },
                },
                select: { id: true, prize: { select: { name: true } } },
              })
            : await tx.lotteryDraw.findFirst({
                where: {
                  jinleeId: userIdentity.jinleeId,
                  status: LotteryStatus.UNUSED,
                  consumeAt: null,
                  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                  prize: { name: { in: RENAME_CARD_NAMES } },
                },
                select: { id: true, prize: { select: { name: true } } },
                orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
              });
          if (!card) return null;

          const updateResult = await tx.lotteryDraw.updateMany({
            where: {
              id: card.id,
              jinleeId: userIdentity.jinleeId,
              status: LotteryStatus.UNUSED,
              consumeAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              prize: { name: { in: RENAME_CARD_NAMES } },
            },
            data: {
              status: LotteryStatus.USED,
              consumeAt: now,
              consumeTargetId: userIdentity.discordUserId,
              consumeTargetJinleeId: userIdentity.jinleeId,
            },
          });
          if (updateResult.count === 1) {
            return card.prize?.name ?? '改名卡';
          }
          if (targetVoucherId) return null;
        }
      };

      const prizeName = await consumeLotteryCard(voucherId);
      if (!prizeName) return { used: false as const };

      return {
        used: true as const,
        prizeName,
        discordUserId: userIdentity.discordUserId,
      };
    });
  } catch (err) {
    const identityError = getIdentityErrorResponse(err);
    if (identityError) {
      sendJson(res, identityError.statusCode, identityError.body);
      return;
    }
    console.error('[internal-api] rename card failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
    return;
  }

  if ('error' in result) {
    sendJson(res, 400, { ok: false, error: result.error });
    return;
  }
  if (!result.used) {
    sendJson(res, 404, { ok: false, error: 'no_card' });
    return;
  }

  const notifyDiscordId = result.discordUserId ?? String(userId);
  const notifyText = `老板 <@${notifyDiscordId}> 使用了${result.prizeName ?? '改名卡'}，请联系老板。`;
  try {
    const channel = await client.channels.fetch(RENAME_NOTIFY_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as any).send({ content: notifyText, allowedMentions: { users: [userId] } });
    }
  } catch (err) {
    console.error('[rename-card] channel notify failed:', err);
  }

  try {
    const user = await client.users.fetch(RENAME_NOTIFY_USER_ID);
    await user.send({ content: notifyText, allowedMentions: { users: [userId] } });
  } catch (err) {
    console.error('[rename-card] dm notify failed:', err);
  }

  sendJson(res, 200, { ok: true });
}

async function handleRevertGift(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const txId = (payload?.transactionId ?? payload?.individualTransactionId)?.toString?.();
  if (!txId) {
    sendJson(res, 400, { ok: false, error: 'missing_transaction_id' });
    return;
  }

  const operatorId = payload?.operatorId?.toString?.() ?? ADMIN_NOTIFY_USER_ID;
  const reason = payload?.reason?.toString?.();

  try {
    await revertGiftByIndividualTx({ transactionId: txId, operatorId, reason });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[internal-api] revert gift failed', err);
    sendJson(res, 500, { ok: false, error: 'revert_failed' });
  }
}

async function handleSyncPeiwanRoles(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const discordUserId = await resolveDiscordId({
    discordId: payload?.discordId,
    peiwanId: payload?.peiwanId,
  });
  const shouldNotify = payload?.notify === true;
  if (!discordUserId) {
    sendJson(res, 400, { ok: false, error: 'missing_target' });
    return;
  }

  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) {
    sendJson(res, 503, { ok: false, error: 'client_not_ready' });
    return;
  }

  try {
    const result = await syncPeiwanRolesForDiscordUser(client, discordUserId);
    if (!result.ok) {
      const statusCode = result.reason === 'member_fetch_failed' ? 503 : 404;
      sendJson(res, statusCode, { ok: false, error: result.reason });
      return;
    }
    if (shouldNotify && result.changed) {
      await sendPeiwanNotification(result.discordUserId, result.peiwanId);
    }

    sendJson(res, 200, {
      ok: true,
      changed: result.changed,
      discordId: result.discordUserId,
      peiwanId: result.peiwanId,
      type: result.type,
      profiles: result.profiles,
    });
  } catch (error) {
    console.error('[internal-api] peiwan role sync failed', { discordUserId, error });
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleSyncAllPeiwanRoles(_req: IncomingMessage, res: ServerResponse) {
  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) {
    sendJson(res, 503, { ok: false, error: 'client_not_ready' });
    return;
  }

  try {
    const summary = await syncAllPeiwanRoles(client);
    sendJson(res, 200, {
      ok: true,
      ...summary,
    });
  } catch (error) {
    console.error('[internal-api] sync all peiwan roles failed', error);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleSyncSpentRoles(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const discordUserId = await resolveDiscordId({
    discordId: payload?.discordId,
    peiwanId: payload?.peiwanId,
  });
  if (!discordUserId) {
    sendJson(res, 400, { ok: false, error: 'missing_target' });
    return;
  }

  try {
    await syncSpentRolesForMember(discordUserId, {
      includeSpendRoles: payload?.includeSpendRoles !== false,
      announceVipUpgrade: payload?.announceVipUpgrade === true,
    });
    sendJson(res, 200, {
      ok: true,
      discordId: discordUserId,
    });
  } catch (error) {
    console.error('[internal-api] spent role sync failed', { discordUserId, error });
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

export function startInternalWebhookServer() {
  if (serverInstance) {
    return serverInstance;
  }

  serverInstance = http.createServer(async (req, res) => {
    applyCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!req.url) {
      sendJson(res, 400, { ok: false, error: 'invalid_url' });
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/internal/withdrawals') {
      await handleWithdrawal(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/withdraw') {
      await handleProcessWithdrawal(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/gift') {
      await handleGift(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/voucher/custom-gift') {
      await handleCustomVoucherUse(
        req,
        res,
        PRIZE_NAMES.CUSTOM_GIFT_VOUCHER,
        '自定义礼物券',
        (userId) => `<@${ADMIN_NOTIFY_USER_ID}>, 用户 <@${userId}> 使用了自定义礼物券`,
        ADMIN_NOTIFY_USER_ID
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/voucher/custom-tag') {
      await handleCustomVoucherUse(
        req,
        res,
        PRIZE_NAMES.CUSTOM_TAG_VOUCHER,
        '自定义tag券',
        (userId) => `<@${ADMIN_NOTIFY_USER_ID}>, 用户 <@${userId}> 使用了自定义tag券`,
        ADMIN_NOTIFY_USER_ID
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/voucher/commission-minus1') {
      await handleCommissionBoost(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/voucher/double-flow-5000') {
      await handleDoubleFlow(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/voucher/double-spend-5000') {
      await handleDoubleSpend(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/voucher/peiwan-review') {
      await handlePeiwanReviewVoucher(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/discount') {
      await handleDiscount(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/lottery/fuse') {
      await handleLotteryFusion(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/rename-card') {
      await handleRenameCard(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/revert-gift') {
      await handleRevertGift(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/peiwan/sync-roles') {
      await handleSyncPeiwanRoles(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/peiwan/sync-roles-all') {
      await handleSyncAllPeiwanRoles(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/spent-role/sync') {
      await handleSyncSpentRoles(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  });

  serverInstance.on('error', (err) => {
    console.error('[internal-api] server error', err);
  });

  serverInstance.listen(INTERNAL_PORT, () => {
    console.log('[internal-api] listening on port', INTERNAL_PORT);
  });

  return serverInstance;
}
