import { Prisma, PrismaClient } from '@prisma/client';

export const RECHARGE_NOTIFY_SKIP_SETTING =
  process.env.RECHARGE_NOTIFY_SKIP_SETTING ?? 'bot.skip_recharge_notify';

type PrismaClientOrTransaction = PrismaClient | Prisma.TransactionClient;

export async function suppressRechargeNotifications(client: PrismaClientOrTransaction) {
  await client.$executeRaw`SELECT set_config(${RECHARGE_NOTIFY_SKIP_SETTING}, 'true', true);`;
}
