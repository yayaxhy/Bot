import { Client, Message } from 'discord.js';
import { Prisma, PrismaClient } from '@prisma/client';
import { isCashAdmin } from './cash.js';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

type TotalEarnCommand = {
  sign: '+' | '-';
  amount: Prisma.Decimal;
  targetId: string;
};

function parseTotalEarnCommand(msg: Message): TotalEarnCommand | null {
  const content = msg.content.trim();
  if (!content.toLowerCase().startsWith('!totalearn')) return null;

  const target = msg.mentions.users.first();
  if (!target) return null;

  let rest = content.slice('!totalearn'.length).trim();
  const mentionRegex = new RegExp(`<@!?${target.id}>`, 'g');
  rest = rest.replace(mentionRegex, '').trim();

  const match = rest.match(/^([+-])\s*([0-9]+(?:\.[0-9]{1,4})?)$/);
  if (!match) return null;

  const sign = match[1] as '+' | '-';
  const amount = DEC(match[2]);
  if (amount.lte(0)) return null;

  return { sign, amount, targetId: target.id };
}

export function registerTotalEarnCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.content.toLowerCase().startsWith('!totalearn')) return;

      if (!isCashAdmin(msg)) {
        await msg.reply('❌ 你没有权限使用该命令。');
        return;
      }

      const parsed = parseTotalEarnCommand(msg);
      if (!parsed) {
        await msg.reply('用法：`!totalearn +金额 @陪玩` 或 `!totalearn -金额 @陪玩`');
        return;
      }

      const { sign, amount, targetId } = parsed;

      const peiwan = await prisma.pEIWAN.findUnique({
        where: { discordUserId: targetId },
        select: { PEIWANID: true, totalEarn: true },
      });

      if (!peiwan) {
        await msg.reply('未找到该陪玩，确认是否已绑定陪玩身份。');
        return;
      }

      const updated = await prisma.pEIWAN.update({
        where: { discordUserId: targetId },
        data:
          sign === '+'
            ? { totalEarn: { increment: amount } }
            : { totalEarn: { decrement: amount } },
        select: { totalEarn: true, PEIWANID: true },
      });

      const verb = sign === '+' ? '增加' : '减少';
      await msg.channel.send(
        `已为陪玩 <@${targetId}>（ID: ${peiwan.PEIWANID}）${verb}流水 **${amount.toString()}**，当前流水：**${updated.totalEarn.toString()}**`
      );
    } catch (err: any) {
      console.error('[totalearn] error:', err);
      try {
        await msg.reply(`❌ 操作失败：${err?.message ?? '未知错误'}`);
      } catch {}
    }
  });
}
