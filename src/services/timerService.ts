import prisma from '../db/prisma.js';
import { OrderStatus } from '@prisma/client';
import { MIN } from '../lib/time.js';
import { recalcOrAutoEnd, endOrder } from './orderService.js';
import { notifyOrderEnded } from './orderNotificationService.js';

const cutoffTimers = new Map<string, NodeJS.Timeout>();
const recalcTimers = new Map<string, NodeJS.Timeout>();
const hourlyTimers = new Map<string, NodeJS.Timeout>();

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
    }, 5 * MIN));
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

        try {
          const user = await (globalThis as any).__CLIENT__.users.fetch(o.hostId);
          await user.send(`总点单时长 **${elapsed}** 分钟，预计金额 **¥${est.toFixed(2)}**。\n余额不足时会自动结单。`);
        } catch {}
      } catch {}
      scheduleHourly();
    }, 60 * MIN));
  };
  scheduleHourly();

  if (order.cutoffAt) {
    const ms = Math.max(0, order.cutoffAt.getTime() - Date.now());
    cutoffTimers.set(orderId, setTimeout(async () => {
      try {
        const result = await endOrder(orderId, order.workerId);
        cancelOrderTimers(orderId);
        if (result?.status === OrderStatus.ENDED) {
          await notifyOrderEnded(orderId);
        }
      } catch (err) {
        console.error('[timerService] cutoff end failed:', err);
      }
    }, ms));
  }
}

export function cancelOrderTimers(orderId: string) {
  [cutoffTimers, recalcTimers, hourlyTimers].forEach(map => {
    const t = map.get(orderId); if (t) clearTimeout(t); map.delete(orderId);
  });
}

/** Rebuild for RUNNING orders after bot restarts */
export async function recoverAllTimers() {
  const running = await prisma.order.findMany({ where: { status: OrderStatus.RUNNING }, select: { id: true } });
  for (const o of running) await scheduleForOrder(o.id);
}
