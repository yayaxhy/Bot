import { Client as PgClient, type Notification } from 'pg';
import prisma from '../db/prisma.js';

const CHANNEL = process.env.PEIWAN_NOTIFY_CHANNEL ?? 'peiwan_profile_channel';
const FUNCTION_NAME = process.env.PEIWAN_TRIGGER_FUNCTION ?? 'notify_peiwan_profile_change';
const TRIGGER_NAME = process.env.PEIWAN_TRIGGER_NAME ?? 'trigger_peiwan_profile_upsert';

type PayloadShape = {
  discordId?: string;
  peiwanId?: number;
};

let listener: PgClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

async function ensureTrigger() {
  const functionSql = `
    CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('${CHANNEL}', json_build_object(
        'discordId', NEW."discordUserId",
        'peiwanId', NEW."PEIWANID"
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;

  const triggerSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${TRIGGER_NAME}') THEN
        CREATE TRIGGER ${TRIGGER_NAME}
        AFTER INSERT OR UPDATE ON "PEIWAN"
        FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}();
      END IF;
    END;
    $$;
  `;

  await prisma.$executeRawUnsafe(functionSql);
  await prisma.$executeRawUnsafe(triggerSql);
}

async function sendPeiwanNotification(discordId: string, peiwanId?: number) {
  const client = (globalThis as any).__CLIENT__ as import('discord.js').Client | undefined;
  if (!client) {
    console.warn('[peiwan.watch] missing discord client', { discordId });
    return;
  }
  try {
    const user = await client.users.fetch(discordId);
    const prefix = peiwanId != null ? `陪玩 ID ${peiwanId}` : '您的陪玩信息';
    await user.send(`${prefix} 已更新，您的信息已经注册完毕`);
    console.log('[peiwan.watch] sent profile DM', { discordId, peiwanId });
  } catch (err) {
    console.error('[peiwan.watch] failed to DM peiwan', { discordId, err });
  }
}

async function processPayload(raw: string | null) {
  if (!raw) return;
  let payload: PayloadShape | null = null;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.warn('[peiwan.watch] invalid payload', raw, err);
    return;
  }

  let discordId = payload?.discordId;
  let peiwanId = payload?.peiwanId;

  if (!discordId) {
    if (!peiwanId) return;
    const record = await prisma.pEIWAN.findUnique({
      where: { PEIWANID: peiwanId },
      select: { discordUserId: true },
    });
    if (!record) {
      console.warn('[peiwan.watch] missing peiwan record', payload);
      return;
    }
    discordId = record.discordUserId;
  }

  await sendPeiwanNotification(discordId, peiwanId);
}

function resolveConnectionString() {
  if (process.env.PEIWAN_DATABASE_URL?.trim()) return process.env.PEIWAN_DATABASE_URL;
  if (process.env.WITHDRAW_DATABASE_URL?.trim()) return process.env.WITHDRAW_DATABASE_URL;
  return process.env.DATABASE_URL;
}

async function connectListener() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    console.warn('[peiwan.watch] DATABASE_URL missing, skip listener');
    return;
  }
  if (listener) {
    return;
  }

  await ensureTrigger().catch((err) => {
    console.error('[peiwan.watch] ensure trigger failed', err);
  });

  const client = new PgClient({
    connectionString,
    keepAlive: true,
    ssl: connectionString.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
  });
  listener = client;

  const handleDisconnect = (cause: unknown) => {
    console.error('[peiwan.watch] listener disconnected', cause);
    cleanup();
    scheduleReconnect();
  };

  client.on('error', (err) => {
    console.error('[peiwan.watch] listener error', err);
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
    console.log('[peiwan.watch] listening on channel', CHANNEL);
  } catch (err) {
    console.error('[peiwan.watch] connect failed', err);
    cleanup();
    scheduleReconnect();
  }
}

function cleanup() {
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
    connectListener().catch((err) => console.error('[peiwan.watch] reconnect failed', err));
  }, delay);
}

export async function startPeiwanWatcher() {
  await connectListener();
}
