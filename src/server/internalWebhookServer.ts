import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { notifyWithdrawal } from '../services/withdrawalNotificationService.js';
import { processWithdrawal } from '../services/withdrawalService.js';
import { performGift } from '../commands/gifting.js';
import prisma from '../db/prisma.js';
import { applyCouponDiscountForOrder, type DiscountKind } from '../services/discountService.js';
import { applyLotteryDiscountForOrder } from '../services/lotteryDiscountService.js';
import { LotteryStatus } from '@prisma/client';
import { PRIZE_NAMES } from '../services/lotteryService.js';
import { applyCommissionBuff, applyFlowBuff } from '../services/buffService.js';

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
const INTERNAL_PORT = Number(process.env.INTERNAL_API_PORT ?? 3710);
const MAX_BODY_SIZE = Number(process.env.INTERNAL_API_MAX_BODY ?? 1024 * 32);
const INTERNAL_API_ORIGIN = process.env.INTERNAL_API_ORIGIN ?? '*';
const INTERNAL_API_ALLOWED_HEADERS =
  process.env.INTERNAL_API_ALLOWED_HEADERS ?? 'Content-Type, X-Internal-Token';
const INTERNAL_API_ALLOWED_METHODS = 'POST, OPTIONS';
const RENAME_NOTIFY_CHANNEL_ID = process.env.RENAME_NOTIFY_CHANNEL_ID ?? '1446819752692416542';
const RENAME_NOTIFY_USER_ID = process.env.RENAME_NOTIFY_USER_ID ?? '1421651539247894549';
const INTERNAL_ALLOWED_IPS = (process.env.INTERNAL_ALLOWED_IPS ?? '43.131.41.173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_NOTIFY_USER_ID = '1421651539247894549';

let serverInstance: http.Server | null = null;

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

async function parseJsonBody(req: IncomingMessage, res: ServerResponse): Promise<any | null> {
  if (!isIpAllowed(req)) {
    console.warn('[internal-api] rejected request from disallowed IP', req.socket.remoteAddress);
    sendJson(res, 403, { ok: false, error: 'forbidden_ip' });
    return null;
  }

  if (INTERNAL_TOKEN) {
    const tokenHeader = req.headers['x-internal-token'];
    if (tokenHeader !== INTERNAL_TOKEN) {
      console.warn('[internal-api] rejected unauthorized request');
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return null;
    }
  }

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

async function consumeVoucher(
  params: {
    userId: string;
    prizeName: string;
    requestId?: string;
  },
  tx: import('@prisma/client').Prisma.TransactionClient
): Promise<{ voucherId: string } | null> {
  const { userId, prizeName, requestId } = params;
  const now = new Date();
  await tx.lotteryDraw.updateMany({
    where: {
      userId,
      status: LotteryStatus.UNUSED,
      expiresAt: { lte: now },
      prize: { name: prizeName },
    },
    data: { status: LotteryStatus.EXPIRED },
  });

  const voucher = await tx.lotteryDraw.findFirst({
    where: {
      userId,
      status: LotteryStatus.UNUSED,
      expiresAt: { gt: now },
      prize: { name: prizeName },
    },
    select: { id: true },
    orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (!voucher) return null;

  await tx.lotteryDraw.update({
    where: { id: voucher.id },
    data: { status: LotteryStatus.USED, consumeAt: now, requestId },
  });

  return { voucherId: voucher.id };
}

async function notifyChannel(message: string) {
  try {
    const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
    if (!client || !RENAME_NOTIFY_CHANNEL_ID) return;
    const channel = await client.channels.fetch(RENAME_NOTIFY_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as any).send({ content: message, allowedMentions: { parse: ['users'] } });
    }
  } catch (err) {
    console.error('[internal-api] notify channel failed:', err);
  }
}

async function handleWithdrawal(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  if (!payload?.userDiscordId || payload.amount == null) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
    return;
  }

  try {
    await notifyWithdrawal({
      userDiscordId: payload.userDiscordId,
      amount: payload.amount,
      requestedAt: payload.requestedAt,
      withdrawalId: payload.withdrawalId,
      note: payload.note,
      currency: payload.currency,
      remainingIncome: payload.remainingIncome,
    });
    sendJson(res, 200, { ok: true });
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
    const statusCode = message.includes('余额不足') || message.includes('未找到') || message.includes('金额') ? 400 : 500;
    sendJson(res, statusCode, { ok: false, error: message });
  }
}

async function handleGift(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { giverId, receiverId, giftName, quantity, anonymous, lotteryId, requestId } = payload ?? {};
  if (!giverId || !receiverId || !giftName || !quantity) {
    sendJson(res, 400, { ok: false, error: 'missing_fields' });
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
      voucherRequestId: requestId,
    });
    sendJson(res, 200, { ok: true, result });
  } catch (err: any) {
    console.error('[internal-api] gift failed', err);
    const message = err?.message ?? 'internal_error';
    const statusCode =
      typeof message === 'string' && message.includes('余额不足')
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
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { userId } = payload ?? {};
  if (!userId) {
    sendJson(res, 400, { ok: false, error: 'missing_user' });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      return consumeVoucher({ userId, prizeName }, tx);
    });

    if (!result) {
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
    sendJson(res, 200, { ok: true, voucherId: result.voucherId });
  } catch (err) {
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

  try {
    const result = await prisma.$transaction(async (tx) => {
      const voucher = await consumeVoucher(
        { userId: payload?.userId ?? userId, prizeName: PRIZE_NAMES.COMMISSION_MINUS1_VOUCHER },
        tx
      );
      if (!voucher) return null;
      const boost = await applyCommissionBuff(tx, userId);
      return { voucherId: voucher.voucherId, expiresAt: boost.expiresAt };
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

  try {
    const result = await prisma.$transaction(async (tx) => {
      const voucher = await consumeVoucher(
        { userId: payload?.userId ?? userId, prizeName: PRIZE_NAMES.DOUBLE_FLOW_5000_VOUCHER },
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
    console.error('[internal-api] double flow boost failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleDiscount(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { orderId, userId, kind } = payload ?? {};
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
          })
        : await applyLotteryDiscountForOrder({
            orderId,
            userId,
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
      amount: result.discountAmount?.toString?.() ?? null,
      kind: result.kind,
    });
  } catch (err) {
    console.error('[internal-api] discount failed', err);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

async function handleRenameCard(req: IncomingMessage, res: ServerResponse) {
  const payload = await parseJsonBody(req, res);
  if (!payload) return;

  const { userId } = payload ?? {};
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

  const used = await prisma.$transaction(async (tx) => {
    await tx.lotteryDraw.updateMany({
      where: {
        userId,
        status: LotteryStatus.UNUSED,
        expiresAt: { lte: now },
        prize: { name: PRIZE_NAMES.RENAME_CARD },
      },
      data: { status: LotteryStatus.EXPIRED },
    });

    const card = await tx.lotteryDraw.findFirst({
      where: {
        userId,
        status: LotteryStatus.UNUSED,
        expiresAt: { gt: now },
        prize: { name: PRIZE_NAMES.RENAME_CARD },
      },
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!card) return false;

    await tx.lotteryDraw.update({
      where: { id: card.id },
      data: { status: LotteryStatus.USED, consumeAt: now },
    });
    return true;
  });

  if (!used) {
    sendJson(res, 404, { ok: false, error: 'no_card' });
    return;
  }

  const notifyText = `老板 <@${userId}> 使用了改名卡，请联系老板。`;
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
    if (req.method === 'POST' && url.pathname === '/internal/discount') {
      await handleDiscount(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/rename-card') {
      await handleRenameCard(req, res);
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
