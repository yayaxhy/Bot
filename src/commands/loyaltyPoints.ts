import { Client, Message } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';
import { isCashAdmin } from './cash.js';
import { adjustLoyaltyPointsTx } from '../services/loyaltyPointService.js';

const COMMAND = '!积分';
const DEC = (value: number | string | Prisma.Decimal) => new Prisma.Decimal(value);

type LoyaltyPointCommand = {
  sign: '+' | '-';
  amount: Prisma.Decimal;
  targetId: string;
};

function parseLoyaltyPointCommand(msg: Message): LoyaltyPointCommand | null {
  const content = msg.content.trim();
  if (!content.startsWith(COMMAND)) return null;

  const target = msg.mentions.users.first();
  if (!target) return null;

  let rest = content.slice(COMMAND.length).trim();
  const mentionRegex = new RegExp(`<@!?${target.id}>`, 'g');
  rest = rest.replace(mentionRegex, '').trim();

  const match = rest.match(/^([+-])\s*([0-9]+(?:\.[0-9]{1,4})?)$/);
  if (!match) return null;

  const sign = match[1] as '+' | '-';
  const amount = DEC(match[2]);
  if (amount.lte(0)) return null;

  return { sign, amount, targetId: target.id };
}

export function registerLoyaltyPointCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.content.trim().startsWith(COMMAND)) return;

      if (!isCashAdmin(msg)) {
        await msg.reply('❌ 你没有权限使用该命令。');
        return;
      }

      const parsed = parseLoyaltyPointCommand(msg);
      if (!parsed) {
        await msg.reply('用法：`!积分 +金额 @用户` 或 `!积分 -金额 @用户`');
        return;
      }

      const { sign, amount, targetId } = parsed;
      const delta = sign === '+' ? amount : amount.mul(-1);

      const updatedPoints = await prisma.$transaction(async (tx) => {
        await tx.member.upsert({
          where: { discordUserId: targetId },
          create: { discordUserId: targetId },
          update: {},
        });

        await adjustLoyaltyPointsTx(tx, targetId, delta);

        const row = await tx.loyaltyPoint.findUnique({
          where: { discordUserId: targetId },
          select: { points: true },
        });
        return row?.points ?? DEC(0);
      });

      const verb = sign === '+' ? '增加' : '减少';
      await msg.channel.send(
        `已为用户 <@${targetId}> ${verb}锦鲤积分 **${amount.toString()}**，当前锦鲤积分：**${updatedPoints.toString()}**`
      );
    } catch (err: any) {
      console.error('[loyalty-points] error:', err);
      try {
        await msg.reply(`❌ 操作失败：${err?.message ?? '未知错误'}`);
      } catch {}
    }
  });
}
