import { AttachmentBuilder, Client, Message } from 'discord.js';
import { Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import prisma from '../db/prisma.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { consumeSpendBuff } from '../services/buffService.js';
import { recordIndividualTransaction } from '../services/individualTransactionService.js';
import {
  buildBlockStackComponents,
  buildBlockStackEmbed,
} from '../ui/blockStackEmbeds.js';

const COMMAND = '!抽积木';
const START_COST = new Prisma.Decimal(49);
const SYSTEM_ID = process.env.BLOCK_STACK_SYSTEM_ID ?? 'block-stack-system';
const BOT_AVATAR_PATH = path.resolve(process.cwd(), 'src', 'img', 'botAvatar.jpg');

const sendToChannel = async (channel: Message['channel'], payload: any) => {
  if (!channel || typeof (channel as any).send !== 'function') return;
  return (channel as any).send(payload);
};

export function registerBlockStackCommand(client: Client) {
  client.on('messageCreate', async (msg: Message) => {
    try {
      if (msg.author.bot) return;
      const content = msg.content.trim();
      if (!content.startsWith(COMMAND)) return;

      if (!msg.guild || !msg.channel) {
        await msg.reply('请在服务器频道里使用该命令。');
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        await tx.member.upsert({
          where: { discordUserId: msg.author.id },
          create: { discordUserId: msg.author.id },
          update: {},
        });
        const member = await tx.member.findUnique({
          where: { discordUserId: msg.author.id },
          select: { income: true, recharge: true, totalBalance: true, totalSpent: true },
        });
        if (!member) throw new Error('member_missing');

        let incomePool = new Prisma.Decimal(member.income ?? 0);
        let rechargePool = new Prisma.Decimal(member.recharge ?? 0);
        const totalBalance = new Prisma.Decimal(member.totalBalance ?? 0);
        const knownPool = incomePool.add(rechargePool);
        const maxAvailable = knownPool.gt(totalBalance) ? knownPool : totalBalance;
        if (maxAvailable.lt(START_COST)) {
          return { status: 'insufficient' as const };
        }
        if (knownPool.lt(START_COST)) {
          const missing = START_COST.sub(knownPool);
          const extra = totalBalance.sub(knownPool);
          if (extra.lt(missing)) {
            return { status: 'insufficient' as const };
          }
          rechargePool = rechargePool.add(missing);
        }

        const split = splitIncomeRecharge(incomePool, rechargePool, START_COST);
        const incomeAfter = incomePool.sub(split.fromIncome);
        const rechargeAfter = rechargePool.sub(split.fromRecharge);
        const totalBalanceAfter = incomeAfter.add(rechargeAfter);
        const spendBonus = await consumeSpendBuff(tx, msg.author.id, START_COST);
        const totalSpentIncrement = START_COST.add(spendBonus.extra);

        await tx.member.update({
          where: { discordUserId: msg.author.id },
          data: {
            income: incomeAfter,
            recharge: rechargeAfter,
            totalBalance: totalBalanceAfter,
            totalSpent: { increment: totalSpentIncrement },
          },
        });

        const peiwan = await tx.pEIWAN.findUnique({
          where: { discordUserId: msg.author.id },
          select: { PEIWANID: true },
        });
        if (peiwan) {
          await tx.pEIWAN.update({
            where: { discordUserId: msg.author.id },
            data: { balance: totalBalanceAfter },
          });
        }

        await recordIndividualTransaction(tx, {
          discordId: msg.author.id,
          thirdPartydiscordId: SYSTEM_ID,
          balanceBefore: split.totalBefore,
          amountChange: START_COST,
          balanceAfter: split.totalAfter,
          typeOfTransaction: '积木游戏启动',
        });

        const game = await tx.blockStackGame.create({
          data: {
            creatorId: msg.author.id,
            channelId: msg.channel.id,
            status: 'ACTIVE',
            totalRevenue: START_COST,
          },
        });
        return { status: 'ok' as const, game };
      });

      if (result.status === 'insufficient') {
        await sendToChannel(msg.channel, '余额不足！');
        return;
      }

      const game = result.game!;
      const embed = buildBlockStackEmbed(game);
      const components = buildBlockStackComponents(game);
      const files = fs.existsSync(BOT_AVATAR_PATH)
        ? [new AttachmentBuilder(BOT_AVATAR_PATH, { name: 'botAvatar.jpg' })]
        : [];
      const sent = await sendToChannel(msg.channel, {
        content: '@here',
        allowedMentions: { parse: ['everyone'] },
        embeds: [embed],
        components,
        ...(files.length ? { files } : {}),
      });
      if (!sent) return;

      try {
        await sent.edit({ embeds: [embed], components, content: '', allowedMentions: { parse: [] } });
      } catch (err) {
        console.error('[block-stack] clear @here failed:', err);
      }

      await prisma.blockStackGame.update({
        where: { id: game.id },
        data: { messageId: sent.id },
      });
    } catch (err) {
      console.error('[block-stack] create failed:', err);
      try { await msg.reply('创建积木游戏失败，请稍后再试。'); } catch {}
    }
  });
}
