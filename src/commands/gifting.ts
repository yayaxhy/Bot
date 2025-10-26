import { Client, Message } from 'discord.js';   // removed GatewayIntentBits
import { Prisma, PrismaClient } from '@prisma/client';
import { postGiftFeed } from '../features/giftFeedHelper.js';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

/** Parse: "!打赏 3/玫瑰 @UserB" */
function parseGiftingCommand(msg: Message): { quantity: number; giftName: string; toUserId: string } | null {
  const content = msg.content.trim();
  if (!content.startsWith('!打赏')) return null;

  const mentioned = msg.mentions.users.first();
  if (!mentioned) return null;

  // slice out everything after "!打赏"
  let rest = content.slice('!打赏'.length).trim();

  // Remove the mention (works for <@id> and <@!id>)
  const mentionRegex = new RegExp(`<@!?${mentioned.id}>`, 'g');
  rest = rest.replace(mentionRegex, '').trim();

  const parts = rest.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const quantity = Number(parts[0]);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  const giftName = parts.slice(1).join('/'); // allow slash in gift name after first slash
  return { quantity, giftName, toUserId: mentioned.id };
}

async function ensureMember(prisma: PrismaClient, discordUserId: string, username?: string) {
  // Add any required defaults if your schema needs them
  return prisma.member.upsert({
    where: { discordUserId },
    update: {},                    // e.g., { username } if you have that field
    create: { discordUserId },     // plus required fields if no defaults
  });
}

export function registerGiftingCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.content.startsWith('!打赏')) return;

      await prisma.interactionLog.create({
        data: {
          memberId: msg.author.id,
          command: '!打赏',
          payload: { content: msg.content } as any, // ensure your Prisma field is Json
        },
      });

      const parsed = parseGiftingCommand(msg);
      if (!parsed) {
        await msg.reply('用法：`!打赏 数量/礼物名 @对方` 例如：`!打赏 3/玫瑰 @Alice`');
        return;
      }

      const giverId = msg.author.id;
      const { toUserId: receiverId, quantity, giftName } = parsed;

      if (giverId === receiverId) {
        await msg.reply('不能给自己打赏哦。');
        return;
      }

      await Promise.all([
        ensureMember(prisma, giverId, msg.author.username),
        ensureMember(prisma, receiverId, msg.mentions.users.first()?.username),
      ]);

      const normalized = giftName.normalize('NFKC').trim();
      const gift = await prisma.gift.findFirst({
        where: { GiftName: giftName },
        select: { GiftName: true, price: true, url_link: true },   // explicit select
      });

      if (!gift) {
        const suggestions = await prisma.gift.findMany({
          where: { GiftName: { contains: normalized, mode: 'insensitive' } },
          take: 5,
          orderBy: { GiftName: 'asc' },
          select: { GiftName: true },
        });
        const hint = suggestions.length
          ? `可选：${suggestions.map(s => s.GiftName).join(', ')}`
          : '（没有相近名称）';
        await msg.reply(`礼物不存在：${giftName}。${hint}`);
        return;
      }

      const qty = DEC(quantity);
      const unitPrice = DEC(gift.price);
      const gross = unitPrice.mul(qty);
      if (gross.lte(0)) {
        await msg.reply('金额必须大于 0。');
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        const receiver = await tx.member.findUnique({ where: { discordUserId: receiverId } });
        if (!receiver) throw new Error('收款方不存在。');

        const receiverRate = DEC(receiver.commissionRate ?? 0);
        const feeRate = DEC(1).sub(receiverRate);
        const feeAmount = gross.mul(feeRate);
        const netAmount = gross.sub(feeAmount);

        const deduct = await tx.member.updateMany({
          where: { discordUserId: giverId, balance: { gte: gross } },
          data: { balance: { decrement: gross }, totalSpent: { increment: gross } },
        });
        if (deduct.count === 0) throw new Error('余额不足，无法打赏。');

        await tx.member.update({
          where: { discordUserId: receiverId },
          data: { balance: { increment: netAmount } },
        });

        const txRow = await tx.transaction.create({
          data: {
            fromId: giverId,
            toId: receiverId,
            amount: gross,
            feeAmount: feeAmount,
            netAmount: netAmount,
          },
          select: { Transid: true }, // adjust to your schema (id/Transid)
        });

        await tx.commission.create({
          data: {
            transactionId: txRow.Transid, // adjust if your key is 'id'
            fromId: giverId,
            toId: receiverId,
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
          imageUrl: gift.url_link ?? undefined,     // <- may be undefined
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

      await postGiftFeed(msg.client, {
        giverId,
        receiverId,
        giftName: result.giftName,
        quantity,
        totalAmount: Number(result.gross.toString()),
        imageUrl: result.imageUrl,                     // optional
      });

      await msg.react('✅');
    } catch (err: any) {
      console.error('[gifting] error:', err);
      try { await msg.reply(`打赏失败：${err?.message ?? '未知错误'}`); } catch {}
    }
  });
}
