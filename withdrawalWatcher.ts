import { Client as PgClient, type Notification } from 'pg';
import prisma from '../db/prisma.js';
import { notifyWithdrawal } from './withdrawalNotificationService.js';

const CHANNEL = process.env.WITHDRAW_NOTIFY_CHANNEL ?? 'withdraw_channel';
const TRIGGER_NAME = process.env.WITHDRAW_TRIGGER_NAME ?? 'trigger_withdraw_insert';
const FUNCTION_NAME = process.env.WITHDRAW_FUNCTION_NAME ?? 'notify_withdraw_insert';

type WithdrawPayload = {
  id: string;
};

let listener: PgClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

async function ensureTrigger() {
  const functionSql = `
    CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('${CHANNEL}', json_build_object('id', NEW.id)::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;

  const triggerSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = '${TRIGGER_NAME}'
      ) THEN
        CREATE TRIGGER ${TRIGGER_NAME}
        AFTER INSERT ON "Withdraw"
        FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}();
      END IF;
    END;
    $$;
  `;

  await prisma.$executeRawUnsafe(functionSql);
  await prisma.$executeRawUnsafe(triggerSql);
}

async function processPayload(raw: string | null) {
  if (!raw) return;
  let payload: WithdrawPayload | null = null;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.warn('[withdraw.watch] invalid payload', raw, err);
    return;
  }

  if (!payload?.id) return;

  const record = await prisma.withdraw.findUnique({
    where: { id: payload.id },
  });

  if (!record) {
    console.warn('[withdraw.watch] missing record for notification', payload);
    return;
  }

  if (record.notifiedAt) {
    return;
  }

  try {
    await notifyWithdrawal({
      userDiscordId: record.discordId,
      amount: record.amount,
      requestedAt: record.createdAt,
      withdrawalId: record.id,
      note: record.method,
      remainingIncome: undefined,
    });

    await prisma.withdraw.update({
      where: { id: record.id },
      data: { notifiedAt: new Date() },
    });
  } catch (err) {
    console.error('[withdraw.watch] failed to notify withdrawal', { id: record.id, err });
  }
}

async function connectListener() {
  if (!process.env.DATABASE_URL) {
    console.warn('[withdraw.watch] DATABASE_URL missing, skip listener');
    return;
  }

  if (listener) {
    return;
  }

  await ensureTrigger().catch((err) => {
    console.error('[withdraw.watch] ensure trigger failed', err);
  });

  const connectionString = process.env.DATABASE_URL;
  const client = new PgClient({
    connectionString,
    keepAlive: true,
    ssl: connectionString?.includes('sslmode=disable')
      ? undefined
      : { rejectUnauthorized: false },
  });
  listener = client;

  const handleDisconnect = (cause: unknown) => {
    console.error('[withdraw.watch] listener disconnected', cause);
    cleanupListener();
    scheduleReconnect();
  };

  client.on('error', (err: Error) => {
    console.error('[withdraw.watch] listener error', err);
    handleDisconnect(err);
  });

  client.on('notification', (msg: Notification) => {
    if (msg.channel !== CHANNEL) return;
    processPayload(msg.payload ?? null);
  });

  client.on('end', () => handleDisconnect('connection ended'));

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    console.log('[withdraw.watch] listening on channel', CHANNEL);
  } catch (err) {
    console.error('[withdraw.watch] connect failed', err);
    cleanupListener();
    scheduleReconnect();
  }
}

function cleanupListener() {
  if (listener) {
    listener.removeAllListeners();
    listener.end().catch(() => {});
    listener = null;
  }
}

function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectListener().catch((err) => console.error('[withdraw.watch] reconnect failed', err));
  }, delayMs);
}

export async function startWithdrawWatcher() {
  await connectListener();
}
