import prisma from './src/db/prisma.js';
import { performGift } from './src/commands/gifting.js';
import { revertGiftByIndividualTx } from './src/services/revertGiftService.js';

async function main() {
  // Extend interactive transaction timeout for testing
  const origTx = prisma.$transaction.bind(prisma);
  (prisma as any).$transaction = ((arg1: any, arg2?: any) => {
    if (typeof arg1 === 'function') {
      return origTx(arg1, { timeout: 20000 });
    }
    return origTx(arg1, arg2);
  }) as any;

  const giverId = 'test_giver_1';
  const receiverId = 'test_receiver_1';
  const giftName = '测试礼物';

  // seed gift
  await prisma.gift.upsert({
    where: { GiftName: giftName },
    create: { GiftName: giftName, price: 50, rate: 1 },
    update: { price: 50, rate: 1 },
  });

  // seed members with balance
  await prisma.member.upsert({
    where: { discordUserId: giverId },
    create: { discordUserId: giverId, income: 500, recharge: 500, totalBalance: 1000 },
    update: { income: 500, recharge: 500, totalBalance: 1000 },
  });
  await prisma.member.upsert({
    where: { discordUserId: receiverId },
    create: { discordUserId: receiverId, income: 0, recharge: 0, totalBalance: 0 },
    update: { income: 0, recharge: 0, totalBalance: 0 },
  });

  const stubClient: any = {
    channels: {
      fetch: async () => ({ isTextBased: () => true, send: async () => {} }),
    },
    users: {
      fetch: async (id: string) => ({ id, username: id, send: async () => {} }),
    },
  };

  console.log('Running performGift...');
  const giftResult = await performGift(stubClient, prisma as any, {
    giverId,
    receiverId,
    giftName,
    quantity: 1,
    anonymous: false,
  });
  console.log('Gift result:', {
    txId: giftResult.txId,
    gross: giftResult.gross.toString(),
    net: giftResult.netAmount.toString(),
  });

  const audit = await prisma.giftAudit.findUnique({ where: { paymentTransactionId: giftResult.txId } });
  if (!audit) throw new Error('Audit not found');
  console.log('Audit individualTransactionId:', audit.individualTransactionId);

  console.log('Running revert...');
  await revertGiftByIndividualTx({ transactionId: audit.individualTransactionId, operatorId: 'tester', reason: 'test run' });

  const giver = await prisma.member.findUnique({ where: { discordUserId: giverId } });
  const receiver = await prisma.member.findUnique({ where: { discordUserId: receiverId } });
  console.log('Balances after revert:', {
    giver: { totalBalance: giver?.totalBalance?.toString(), income: giver?.income?.toString(), recharge: giver?.recharge?.toString(), totalSpent: giver?.totalSpent?.toString() },
    receiver: { totalBalance: receiver?.totalBalance?.toString(), income: receiver?.income?.toString() },
  });

  const revertRow = await prisma.revert.findFirst({ where: { originalTransactionId: audit.individualTransactionId } });
  console.log('Revert row:', revertRow);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
