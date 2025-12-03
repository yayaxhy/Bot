import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __PRISMA__: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __PRISMA_READY__: Promise<void> | undefined;
}

export const prisma = global.__PRISMA__ ?? new PrismaClient();

const connectPromise =
  global.__PRISMA_READY__ ??
  prisma.$connect().catch((err) => {
    console.error('[prisma] initial $connect failed:', err);
    throw err;
  });

export const prismaReady = connectPromise;

export default prisma;

if (process.env.NODE_ENV !== 'production') {
  global.__PRISMA__ = prisma;
  global.__PRISMA_READY__ = connectPromise;
}
