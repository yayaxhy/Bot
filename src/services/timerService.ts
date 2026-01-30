import prisma from '../db/prisma.js';
import { OrderStatus } from '@prisma/client';
import { MIN } from '../lib/time.js';
import { recalcOrAutoEnd, endOrder, chargePendingMinutes } from './orderService.js';
import { notifyOrderEnded } from './orderNotificationService.js';

const cutoffTimers = new Map<string, NodeJS.Timeout>();
const recalcTimers = new Map<string, NodeJS.Timeout>();
const hourlyTimers = new Map<string, NodeJS.Timeout>();
const billingTimers = new Map<string, NodeJS.Timeout>();
let guardInterval: NodeJS.Timeout | null = null;
let globalRecalcInterval: NodeJS.Timeout | null = null;
let guardRunning = false;
let globalRecalcRunning = false;

const ORDER_TIMER_GUARD_MS = Number(process.env.ORDER_TIMER_GUARD_MS ?? MIN);
const ORDER_GLOBAL_RECALC_MS = Number(process.env.ORDER_GLOBAL_RECALC_MS ?? MIN);
const ORDER_TIMER_GUARD_ENABLED = (process.env.ORDER_TIMER_GUARD_ENABLED ?? 'true') !== 'false';
const ORDER_GLOBAL_RECALC_ENABLED = (process.env.ORDER_GLOBAL_RECALC_ENABLED ?? 'true') !== 'false';

function hasAllTimers(orderId: string) {
  return (
    cutoffTimers.has(orderId) &&
    recalcTimers.has(orderId) &&
    hourlyTimers.has(orderId) &&
    billingTimers.has(orderId)
  );
}

function allTimerOrderIds(): string[] {
  return Array.from(
    new Set([
      ...cutoffTimers.keys(),
      ...recalcTimers.keys(),
      ...hourlyTimers.keys(),
      ...billingTimers.keys(),
    ])
  );
}

export async function scheduleForOrder(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== OrderStatus.RUNNING) return;

  cancelOrderTimers(orderId);

  const scheduleRecalc = () => {
    recalcTimers.set(orderId, setTimeout(async () => {
      try {
        const { ended } = await recalcOrAutoEnd(orderId);
        if (ended) {
          cancelOrderTimers(orderId);
          await notifyOrderEnded(orderId);
          return;
        }
      } catch (err) {
        console.error('[timerService] recalc failed:', err);
      }
      scheduleRecalc();
    }, MIN));
  };
  scheduleRecalc();

  const scheduleHourly = () => {
    hourlyTimers.set(orderId, setTimeout(async () => {
      try {
        const o = await prisma.order.findUnique({ where: { id: orderId } });
        if (!o || o.status !== OrderStatus.RUNNING) {
          cancelOrderTimers(orderId);
          return;
        }
        const now = new Date();
        const elapsed = o.stopwatchStartAt ? Math.ceil((now.getTime() - o.stopwatchStartAt.getTime())/60000) : 0;
        const est = o.unitPrice ? Number(o.unitPrice.toString()) * (elapsed / 60) : 0;

        let hostUser: any = null;
        let workerUser: any = null;
        try {
          hostUser = await (globalThis as any).__CLIENT__.users.fetch(o.hostId);
        } catch {}
        try {
          workerUser = await (globalThis as any).__CLIENT__.users.fetch(o.workerId);
        } catch {}

        const workerName = workerUser?.username ?? workerUser?.tag ?? o.workerId;
        const hostName = hostUser?.username ?? hostUser?.tag ?? o.hostId;

        try {
          if (hostUser) {
            await hostUser.send(
              `您与陪玩 ${workerName} 总点单时长 **${elapsed}** 分钟，预计金额 **¥${est.toFixed(2)}**。余额不足时会自动结单。`
            );
          }
        } catch {}

        try {
          if (workerUser) {
            await workerUser.send(
              `您与老板 ${hostName} 总点单时长 **${elapsed}** 分钟，预计金额 **¥${est.toFixed(2)}**。老板余额不足时会自动结单。`
            );
          }
        } catch {}
      } catch {}
      scheduleHourly();
    }, 60 * MIN));
  };
  scheduleHourly();

  const scheduleBilling = () => {
    billingTimers.set(orderId, setTimeout(async () => {
      try {
        const chargeResult = await chargePendingMinutes(orderId);
        if (chargeResult.insufficient) {
          const { ended } = await recalcOrAutoEnd(orderId);
          if (ended) {
            cancelOrderTimers(orderId);
            await notifyOrderEnded(orderId);
            return;
          }
        }
      } catch (err) {
        console.error('[timerService] billing charge failed:', err);
      }
      scheduleBilling();
    }, MIN));
  };
  scheduleBilling();

  const scheduleCutoff = () => {
    const tick = async () => {
      try {
        const latest = await prisma.order.findUnique({
          where: { id: orderId },
          select: { status: true, cutoffAt: true, workerId: true },
        });
        if (!latest || latest.status !== OrderStatus.RUNNING) {
          const timer = cutoffTimers.get(orderId);
          if (timer) clearTimeout(timer);
          cutoffTimers.delete(orderId);
          return;
        }
        if (latest.cutoffAt && latest.cutoffAt.getTime() <= Date.now()) {
          try {
            const result = await endOrder(orderId, latest.workerId);
            cancelOrderTimers(orderId);
            if (result?.status === OrderStatus.ENDED) {
              await notifyOrderEnded(orderId);
            }
          } catch (err) {
            console.error('[timerService] cutoff end failed:', err);
          }
          return;
        }
      } catch (err) {
        console.error('[timerService] cutoff poll failed:', err);
      }
      cutoffTimers.set(orderId, setTimeout(tick, MIN));
    };
    cutoffTimers.set(orderId, setTimeout(tick, MIN));
  };
  scheduleCutoff();
}

export function cancelOrderTimers(orderId: string) {
  [cutoffTimers, recalcTimers, hourlyTimers, billingTimers].forEach(map => {
    const t = map.get(orderId); if (t) clearTimeout(t); map.delete(orderId);
  });
}

/** Rebuild for RUNNING orders after bot restarts */
export async function recoverAllTimers() {
  const running = await prisma.order.findMany({ where: { status: OrderStatus.RUNNING }, select: { id: true } });
  for (const o of running) await scheduleForOrder(o.id);
}

/** Guard: ensure every RUNNING order has timers */
export function startOrderTimerGuard() {
  if (!ORDER_TIMER_GUARD_ENABLED || guardInterval) return;
  guardInterval = setInterval(async () => {
    if (guardRunning) return;
    guardRunning = true;
    try {
      const running = await prisma.order.findMany({
        where: { status: OrderStatus.RUNNING },
        select: { id: true },
      });
      const runningIds = new Set(running.map((o) => o.id));

      for (const id of runningIds) {
        if (!hasAllTimers(id)) {
          await scheduleForOrder(id);
        }
      }

      for (const id of allTimerOrderIds()) {
        if (!runningIds.has(id)) {
          cancelOrderTimers(id);
        }
      }
    } catch (err) {
      console.error('[timerService] guard failed:', err);
    } finally {
      guardRunning = false;
    }
  }, ORDER_TIMER_GUARD_MS);
}

/** Global fallback: recalc all RUNNING orders periodically */
export function startGlobalRecalcLoop() {
  if (!ORDER_GLOBAL_RECALC_ENABLED || globalRecalcInterval) return;
  globalRecalcInterval = setInterval(async () => {
    if (globalRecalcRunning) return;
    globalRecalcRunning = true;
    try {
      const running = await prisma.order.findMany({
        where: { status: OrderStatus.RUNNING },
        select: { id: true },
      });
      for (const o of running) {
        try {
          const { ended } = await recalcOrAutoEnd(o.id);
          if (ended) await notifyOrderEnded(o.id);
        } catch (err) {
          console.error('[timerService] global recalc failed:', { orderId: o.id, err });
        }
      }
    } catch (err) {
      console.error('[timerService] global recalc loop failed:', err);
    } finally {
      globalRecalcRunning = false;
    }
  }, ORDER_GLOBAL_RECALC_MS);
}
