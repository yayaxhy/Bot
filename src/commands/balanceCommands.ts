import { Client, Message } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { isCashAdmin } from './cash.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { recordIndividualTransaction } from '../services/individualTransactionService.js';
import { suppressRechargeNotifications } from '../services/rechargeNotifyConfig.js';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

function parseAmountAndMentions(
  msg: Message,
  prefix: string
): { amount: Prisma.Decimal; ids: string[] } | null {
  const content = msg.content.trim();
  if (!content.startsWith(prefix)) return null;

  const mentionMatches = Array.from(content.matchAll(/<@!?(\d+)>/g));
  const orderedIds = mentionMatches.map((m) => m[1]).filter(Boolean);
  const uniqueMentionIds = Array.from(new Set(orderedIds));
  if (uniqueMentionIds.length === 0) return null;

  let rest = content.slice(prefix.length).trim();
  for (const id of uniqueMentionIds) {
    const mentionRegex = new RegExp(`<@!?${id}>`, 'g');
    rest = rest.replace(mentionRegex, ' ');
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  if (!rest) return null;

  const amountNum = Number(rest.split(/\s+/)[0]);
  if (!Number.isFinite(amountNum) || amountNum <= 0) return null;
  return { amount: DEC(amountNum), ids: uniqueMentionIds };
}

function parseRealCashCommand(
  msg: Message
): { sign: '+' | '-'; amount: Prisma.Decimal; targetId: string } | null {
  const content = msg.content.trim();
  if (!content.toLowerCase().startsWith('!realcash')) return null;

  const mentionMatches = Array.from(content.matchAll(/<@!?(\d+)>/g));
  const uniqueMentionIds = Array.from(new Set(mentionMatches.map((m) => m[1]).filter(Boolean)));
  if (uniqueMentionIds.length !== 1) return null;

  let rest = content.slice('!realcash'.length).trim();
  const mentionRegex = new RegExp(`<@!?${uniqueMentionIds[0]}>`, 'g');
  rest = rest.replace(mentionRegex, ' ').replace(/\s+/g, ' ').trim();

  const m = rest.match(/^([+-])\s*([0-9]+(?:\.[0-9]{1,4})?)$/);
  if (!m) return null;

  const sign = m[1] as '+' | '-';
  const amount = DEC(m[2]);
  if (amount.lte(0)) return null;

  return { sign, amount, targetId: uniqueMentionIds[0] };
}

export function registerBalanceCommands(client: Client) {
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;

      // !realcash +100 @用户  （recharge -> income）
      // !realcash -100 @用户  （income -> recharge）
      if (msg.content.trim().toLowerCase().startsWith('!realcash')) {
        try {
          if (!isCashAdmin(msg)) {
            await msg.channel.send('❌ 你没有权限使用该命令。');
            return;
          }

          const parsed = parseRealCashCommand(msg);
          if (!parsed) {
            await msg.channel.send('用法：`!realcash +金额 @用户` 或 `!realcash -金额 @用户`');
            return;
          }

          const { sign, amount, targetId } = parsed;

          const updated = await prisma.$transaction(async (tx) => {
            await suppressRechargeNotifications(tx);

            const before = await tx.member.findUnique({
              where: { discordUserId: targetId },
              select: { income: true, recharge: true, totalBalance: true },
            });
            if (!before) {
              throw new Error('TARGET_NOT_FOUND');
            }

            const incomeBefore = DEC(before.income ?? 0);
            const rechargeBefore = DEC(before.recharge ?? 0);

            if (sign === '+') {
              if (rechargeBefore.lt(amount)) {
                throw new Error('INSUFFICIENT_RECHARGE');
              }

              return tx.member.update({
                where: { discordUserId: targetId },
                data: {
                  recharge: { decrement: amount },
                  income: { increment: amount },
                },
                select: { income: true, recharge: true, totalBalance: true },
              });
            }

            if (incomeBefore.lt(amount)) {
              throw new Error('INSUFFICIENT_INCOME');
            }

            return tx.member.update({
              where: { discordUserId: targetId },
              data: {
                income: { decrement: amount },
                recharge: { increment: amount },
              },
              select: { income: true, recharge: true, totalBalance: true },
            });
          });

          await msg.channel.send(
            `调账成功，可以提现余额：${DEC(updated.income ?? 0).toFixed(2)}，充值余额：${DEC(updated.recharge ?? 0).toFixed(2)}，总余额：${DEC(updated.totalBalance ?? 0).toFixed(2)}`
          );
          return;
        } catch (err: any) {
          const code = String(err?.message ?? '');
          if (code === 'TARGET_NOT_FOUND') {
            await msg.channel.send('调账失败：用户不存在。');
            return;
          }
          if (code === 'INSUFFICIENT_RECHARGE') {
            await msg.channel.send('调账失败：充值余额不足。');
            return;
          }
          if (code === 'INSUFFICIENT_INCOME') {
            await msg.channel.send('调账失败：可提现余额不足。');
            return;
          }
          console.error('[realcash] error', err);
          await msg.channel.send('调账失败，请稍后再试。');
          return;
        }
      }

      // !扣款 金额 @用户
      if (msg.content.trim().startsWith('!扣款')) {
        if (!isCashAdmin(msg)) {
          await msg.reply('❌ 你没有权限使用该命令。');
          return;
        }
        const parsed = parseAmountAndMentions(msg, '!扣款');
        if (!parsed || parsed.ids.length !== 1) {
          await msg.reply('用法：`!扣款 金额 @用户`');
          return;
        }
        const targetId = parsed.ids[0];
        const amount = parsed.amount;

        await prisma.$transaction(async (tx) => {
          const member = await tx.member.findUnique({
            where: { discordUserId: targetId },
            select: { income: true, recharge: true, totalBalance: true },
          });
          if (!member) throw new Error('Member missing');

          const split = splitIncomeRecharge(member.income ?? 0, member.recharge ?? 0, amount);
          await tx.member.update({
            where: { discordUserId: targetId },
            data: {
              income: { decrement: split.fromIncome },
              recharge: { decrement: split.fromRecharge },
              totalBalance: { decrement: amount },
            },
          });

          await tx.pureProfit.create({
            data: {
              amount,
              operatorId: msg.author.id,
              targetId,
              reason: '扣款',
            },
          });

          await recordIndividualTransaction(tx, {
            discordId: targetId,
            thirdPartydiscordId: msg.author.id,
            balanceBefore: split.totalBefore,
            amountChange: amount.neg(),
            balanceAfter: split.totalAfter,
            typeOfTransaction: '扣款',
          });
        });

        await msg.reply(`已从 <@${targetId}> 扣除 ${amount.toString()}。`);
        return;
      }

      // !转移余额 金额 @用户A @用户B
      if (msg.content.trim().startsWith('!转移余额')) {
        if (!isCashAdmin(msg)) {
          await msg.reply('❌ 你没有权限使用该命令。');
          return;
        }
        const parsed = parseAmountAndMentions(msg, '!转移余额');
        if (!parsed || parsed.ids.length !== 2) {
          await msg.reply('用法：`!转移余额 金额 @用户A @用户B`');
          return;
        }
        const [fromId, toId] = parsed.ids;
        const amount = parsed.amount;
        if (fromId === toId) {
          await msg.reply('转出与转入用户不能相同。');
          return;
        }

        await prisma.$transaction(async (tx) => {
          const from = await tx.member.findUnique({
            where: { discordUserId: fromId },
            select: { income: true, recharge: true, totalBalance: true },
          });
          if (!from) throw new Error('Member missing');

          const split = splitIncomeRecharge(from.income ?? 0, from.recharge ?? 0, amount);
          await tx.member.update({
            where: { discordUserId: fromId },
            data: {
              income: { decrement: split.fromIncome },
              recharge: { decrement: split.fromRecharge },
              totalBalance: { decrement: amount },
            },
          });

          const toBeforeRow = await tx.member.upsert({
            where: { discordUserId: toId },
            create: { discordUserId: toId },
            update: {},
            select: { totalBalance: true },
          });
          const toBalanceBefore = new Prisma.Decimal(toBeforeRow.totalBalance ?? 0);
          const toBalanceAfter = toBalanceBefore.add(amount);

          await tx.member.update({
            where: { discordUserId: toId },
            data: {
              recharge: { increment: amount },
              totalBalance: { increment: amount },
            },
          });

          await recordIndividualTransaction(tx, {
            discordId: fromId,
            thirdPartydiscordId: toId,
            balanceBefore: split.totalBefore,
            amountChange: amount.neg(),
            balanceAfter: split.totalAfter,
            typeOfTransaction: '余额转移-转出',
          });

          await recordIndividualTransaction(tx, {
            discordId: toId,
            thirdPartydiscordId: fromId,
            balanceBefore: toBalanceBefore,
            amountChange: amount,
            balanceAfter: toBalanceAfter,
            typeOfTransaction: '余额转移-转入',
          });
        });

        await msg.reply(`已从 <@${fromId}> 转移 ${amount.toString()} 给 <@${toId}>。`);
        return;
      }
    } catch (err: any) {
      const msgText = typeof err?.message === 'string' ? err.message : '操作失败';
      if (msgText.includes('INSUFFICIENT_FUNDS')) {
        await msg.reply('余额不足，转移/扣款失败。');
        return;
      }
      console.error('[balanceCommands] error', err);
      try { await msg.reply('操作失败，请稍后再试。'); } catch {}
    }
  });
}
