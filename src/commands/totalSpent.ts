import { Client, Message } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';
import { isCashAdmin } from './cash.js';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

type TotalSpentCommand = {
  sign: '+' | '-';
  amount: Prisma.Decimal;
  targetId: string;
};

function parseTotalSpentCommand(msg: Message): TotalSpentCommand | null {
  const content = msg.content.trim();
  if (!content.toLowerCase().startsWith('!totalspent')) return null;

  const target = msg.mentions.users.first();
  if (!target) return null;

  let rest = content.slice('!totalspent'.length).trim();
  const mentionRegex = new RegExp(`<@!?${target.id}>`, 'g');
  rest = rest.replace(mentionRegex, '').trim();

  const match = rest.match(/^([+-])\s*([0-9]+(?:\.[0-9]{1,4})?)$/);
  if (!match) return null;

  const sign = match[1] as '+' | '-';
  const amount = DEC(match[2]);
  if (amount.lte(0)) return null;

  return { sign, amount, targetId: target.id };
}

export function registerTotalSpentCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.content.toLowerCase().startsWith('!totalspent')) return;

      if (!isCashAdmin(msg)) {
        await msg.reply('❌ 你没有权限使用该命令。');
        return;
      }

      const parsed = parseTotalSpentCommand(msg);
      if (!parsed) {
        await msg.reply('用法：`!totalspent +金额 @用户` 或 `!totalspent -金额 @用户`');
        return;
      }

      const { sign, amount, targetId } = parsed;

      const member = await prisma.member.findUnique({
        where: { discordUserId: targetId },
        select: { discordUserId: true, totalSpent: true },
      });

      if (!member) {
        await msg.reply('未找到该用户，确认是否已绑定会员身份。');
        return;
      }

      const updated = await prisma.member.update({
        where: { discordUserId: targetId },
        data:
          sign === '+'
            ? { totalSpent: { increment: amount } }
            : { totalSpent: { decrement: amount } },
        select: { totalSpent: true, discordUserId: true },
      });

      const verb = sign === '+' ? '增加' : '减少';
      await msg.channel.send(
        `已为用户 <@${targetId}> ${verb}消费 **${amount.toString()}**，当前消费：**${updated.totalSpent.toString()}**`
      );
    } catch (err: any) {
      console.error('[totalspent] error:', err);
      try {
        await msg.reply(`❌ 操作失败：${err?.message ?? '未知错误'}`);
      } catch {}
    }
  });
}
