import { Client, GatewayIntentBits, Message } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

/** Parse: "!打赏 3/玫瑰 @UserB" */
function parseGiftingCommand(msg: Message): { quantity: number; giftName: string; toUserId: string } | null {
  const content = msg.content.trim();
  if (!content.startsWith('!打赏')) return null;

  const mention = msg.mentions.users.first();
  if (!mention) return null;

  // slice out everything after "!打赏"
  const rest = content.slice('!打赏'.length).trim();

  // Remove the mention to isolate "<qty>/<giftName>"
  const mentionToken = `<@${mention.id}>`;
  const idx = rest.lastIndexOf(mentionToken);
  const head = idx >= 0 ? rest.slice(0, idx).trim() : rest;

  const parts = head.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const quantity = Number(parts[0]);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  const giftName = parts.slice(1).join('/'); // allow slash in gift name after first slash
  return { quantity, giftName, toUserId: mention.id };
}

async function ensureMember(prisma: PrismaClient, discordUserId: string, username?: string) {
  // Uses your defaults: balance 0, commissionRate 0.75 (schema default)
  return prisma.member.upsert({
    where: { discordUserId },
    update: { /* keep username or store if you add a field later */ },
    create: {
      discordUserId,
      // status defaults to LAOBAN
      // balance defaults to 0 (Decimal(19,4))
      // totalSpent defaults to 0 (Decimal(19,4))
      // commissionRate defaults to 0.75 (Decimal(7,6))
    },
  });
}

export function registerGiftingCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.content.startsWith('!打赏')) return;

      // Log the raw interaction
      await prisma.interactionLog.create({
        data: {
          memberId: msg.author.id,
          command: '!打赏',
          payload: { content: msg.content },
        },
      });

      const parsed = parseGiftingCommand(msg);
      if (!parsed) {
        await msg.reply('用法：`!打赏 数量/礼物名 @对方` 例如：`!打赏 3/玫瑰 @Alice`');
        return;
      }

      const fromId = msg.author.id;
      const { toUserId: toId, quantity, giftName } = parsed;
      if (fromId === toId) {
        await msg.reply('不能给自己打赏哦。');
        return;
      }

      // Make sure both members exist (uses your schema defaults)
      await Promise.all([
        ensureMember(prisma, fromId, msg.author.username),
        ensureMember(prisma, toId, msg.mentions.users.first()?.username),
      ]);

      // Look up gift by GiftName (not unique in your schema, so use findFirst)
      const normalized = giftName.normalize('NFKC').trim();

      const gift = await prisma.gift.findFirst({
        where: { GiftName: giftName },
      });
      if (!gift) {
        const suggestions = await prisma.gift.findMany({
    where: { GiftName: { contains: normalized, mode: 'insensitive' } },
    take: 5,
    orderBy: { GiftName: 'asc' },
  });
  const hint = suggestions.length
    ? `可选：${suggestions.map(s => s.GiftName).join(', ')}`
    : '（没有相近名称）';
  await msg.reply(`礼物不存在：${giftName}。${hint}`);
  return;
      }

      // Compute gross / fee / net using receiver’s commissionRate (payout ratio)
      const qty = DEC(quantity);
      const unitPrice = DEC(gift.price);
      const gross = unitPrice.mul(qty); // Decimal
      if (gross.lte(0)) {
        await msg.reply('金额必须大于 0。');
        return;
      }

      // Transaction: deduct sender, credit receiver, record Transaction + Commission
      const result = await prisma.$transaction(async (tx) => {
        // Load receiver commissionRate snapshot
        const receiver = await tx.member.findUnique({ where: { discordUserId: toId } });
        if (!receiver) throw new Error('收款方不存在。');

        const receiverRate = DEC(receiver.commissionRate ?? 0); // payout ratio
        const feeRate = DEC(1).sub(receiverRate);
        const feeAmount = gross.mul(feeRate);
        const netAmount = gross.sub(feeAmount);

        // 1) Deduct sender atomically (guard balance >= gross)
        const deduct = await tx.member.updateMany({
          where: {
            discordUserId: fromId,
            balance: { gte: gross },
          },
          data: {
            balance: { decrement: gross },
            totalSpent: { increment: gross },
          },
        });
        if (deduct.count === 0) {
          throw new Error('余额不足，无法打赏。');
        }

        // 2) Credit receiver
        await tx.member.update({
          where: { discordUserId: toId },
          data: {
            balance: { increment: netAmount },
          },
        });

        // 3) Create Transaction (ties to Member via from/to relations)
        const txRow = await tx.transaction.create({
          data: {
            fromId: fromId,
            toId: toId,
            amount: gross,
            feeAmount: feeAmount,
            netAmount: netAmount,
            // createdAt default now()
          },
        });

        // 4) Create Commission snapshot row linked to the Transaction
        await tx.commission.create({
          data: {
            transactionId: txRow.Transid,
            fromId: fromId,
            toId: toId,
            feeAmount: feeAmount,
          },
        });

        return {
          txId: txRow.Transid,
          unitPrice,
          qty,
          gross,
          receiverRate,
          feeAmount,
          netAmount,
          giftName: gift.GiftName,
        };
      });

      await msg.reply(
        [
          `🎁 打赏成功！（交易号：${result.txId}）`,
          `礼物：${result.giftName} × ${result.qty.toString()}`,
          `单价：${result.unitPrice.toString()}`,
          `总额（GROSS）：${result.gross.toString()}`,
          `收款方分成比例（commissionRate）：${result.receiverRate.toString()}`,
          `平台抽取（FEE）：${result.feeAmount.toString()}`,
          `到账（NET）：${result.netAmount.toString()}`,
        ].join('\n')
      );
    } catch (err: any) {
      console.error('[gifting] error:', err);
      try {
        await msg.reply(`打赏失败：${err?.message ?? '未知错误'}`);
      } catch {}
    }
  });
}
