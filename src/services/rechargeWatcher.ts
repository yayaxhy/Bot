import { Prisma } from '@prisma/client';
import { Client as PgClient, type Notification } from 'pg';
import prisma from '../db/prisma.js';
import { RECHARGE_NOTIFY_SKIP_SETTING } from './rechargeNotifyConfig.js';

const CHANNEL = process.env.RECHARGE_NOTIFY_CHANNEL ?? 'member_recharge_channel';
const FUNCTION_NAME = process.env.RECHARGE_TRIGGER_FUNCTION ?? 'notify_member_recharge';
const TRIGGER_NAME = process.env.RECHARGE_TRIGGER_NAME ?? 'trigger_member_recharge_update';

type RechargePayload = {
  discordId?: string;
  amount?: string | number;
  balanceAfter?: string | number;
};

let listener: PgClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

async function ensureTrigger() {
  // Make sure the GUC is not left as an empty string; try to default it to 'false' at DB level.
  const enforceDefaultSql = `
    DO $$
    BEGIN
      IF current_setting('${RECHARGE_NOTIFY_SKIP_SETTING}', true) IS NULL
         OR current_setting('${RECHARGE_NOTIFY_SKIP_SETTING}', true) = '' THEN
        BEGIN
          EXECUTE format('ALTER DATABASE %I SET %I = %L', current_database(), '${RECHARGE_NOTIFY_SKIP_SETTING}', 'false');
        EXCEPTION
          WHEN insufficient_privilege THEN
            -- Fallback: set session-level so at least this connection is safe
            PERFORM set_config('${RECHARGE_NOTIFY_SKIP_SETTING}', 'false', false);
        END;
      END IF;
    END $$;
  `;

  const functionSql = `
    CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}() RETURNS trigger AS $$
    DECLARE
      prev_value NUMERIC := COALESCE(OLD."recharge", 0);
      next_value NUMERIC := COALESCE(NEW."recharge", 0);
      delta NUMERIC := next_value - prev_value;
      skip_setting TEXT := current_setting('${RECHARGE_NOTIFY_SKIP_SETTING}', true);
      skip BOOLEAN := false;
    BEGIN
      IF skip_setting IS NOT NULL THEN
        BEGIN
          -- tolerate blank/invalid values; treat as false instead of raising
          skip := COALESCE(NULLIF(skip_setting, '')::boolean, false);
        EXCEPTION
          WHEN others THEN
            skip := false;
        END;
      END IF;

      IF skip OR delta <= 0 THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify(
        '${CHANNEL}',
        json_build_object(
          'discordId', NEW."discordUserId",
          'amount', delta,
          'balanceAfter', COALESCE(NEW."totalBalance", 0)
        )::text
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;

  const triggerSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${TRIGGER_NAME}') THEN
        CREATE TRIGGER ${TRIGGER_NAME}
        AFTER UPDATE ON "Member"
        FOR EACH ROW
        EXECUTE FUNCTION ${FUNCTION_NAME}();
      END IF;
    END;
    $$;
  `;

  await prisma.$executeRawUnsafe(functionSql);
  await prisma.$executeRawUnsafe(triggerSql);
  await prisma.$executeRawUnsafe(enforceDefaultSql);
}

function resolveConnectionString() {
  if (process.env.RECHARGE_DATABASE_URL?.trim()) return process.env.RECHARGE_DATABASE_URL;
  if (process.env.WITHDRAW_DATABASE_URL?.trim()) return process.env.WITHDRAW_DATABASE_URL;
  return process.env.DATABASE_URL;
}

async function sendRechargeNotification(payload: RechargePayload) {
  if (!payload?.discordId || payload.amount == null) {
    return;
  }

  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) {
    console.warn('[recharge.watch] missing discord client');
    return;
  }

  const amount = new Prisma.Decimal(payload.amount);
  if (amount.lte(0)) {
    return;
  }

  const balanceAfter =
    payload.balanceAfter != null ? new Prisma.Decimal(payload.balanceAfter) : null;

  try {
    const user = await client.users.fetch(payload.discordId);
    const balanceText = balanceAfter ? balanceAfter.toString() : '未知';
    await user.send(
      `网站自动充值成功！已为您增加余额 **${amount.toString()}**。当前余额：**${balanceText}**`
    );
    console.log('[recharge.watch] sent notification', {
      discordId: payload.discordId,
      amount: amount.toString(),
    });
  } catch (err) {
    console.error('[recharge.watch] failed to notify user', {
      discordId: payload.discordId,
      err,
    });
  }
}

async function processPayload(raw: string | null) {
  if (!raw) return;
  let payload: RechargePayload | null = null;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.warn('[recharge.watch] invalid payload', raw, err);
    return;
  }

  if (!payload) return;
  await sendRechargeNotification(payload);
}

function cleanupListener() {
  if (listener) {
    listener.removeAllListeners();
    listener.end().catch(() => {});
    listener = null;
  }
}

function scheduleReconnect(delay = 5000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectListener().catch((err) => console.error('[recharge.watch] reconnect failed', err));
  }, delay);
}

async function connectListener() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    console.warn('[recharge.watch] DATABASE_URL missing, skip listener');
    return;
  }

  if (listener) {
    return;
  }

  await ensureTrigger().catch((err) => {
    console.error('[recharge.watch] ensure trigger failed', err);
  });

  const client = new PgClient({
    connectionString,
    keepAlive: true,
    ssl: connectionString.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
  });
  listener = client;

  const handleDisconnect = (cause: unknown) => {
    console.error('[recharge.watch] listener disconnected', cause);
    cleanupListener();
    scheduleReconnect();
  };

  client.on('error', (err) => {
    console.error('[recharge.watch] listener error', err);
    handleDisconnect(err);
  });

  client.on('end', () => handleDisconnect('connection ended'));

  client.on('notification', (msg: Notification) => {
    if (msg.channel !== CHANNEL) return;
    processPayload(msg.payload ?? null);
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    console.log('[recharge.watch] listening on channel', CHANNEL);
  } catch (err) {
    console.error('[recharge.watch] connect failed', err);
    cleanupListener();
    scheduleReconnect();
  }
}

export async function startRechargeWatcher() {
  await connectListener();
}
