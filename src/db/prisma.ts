import { PrismaClient } from '@prisma/client';

declare global { var __PRISMA__: PrismaClient | undefined }

export const prisma = global.__PRISMA__ ?? new PrismaClient();

export default prisma;


if (process.env.NODE_ENV !== 'production') {
  global.__PRISMA__ = prisma;
}
