import { AttachmentBuilder, Client, Message } from 'discord.js';
import { CouponStatus, LotteryStatus, PointShopDeliveryStatus, PointShopDeliveryType, Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import prisma from '../db/prisma.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { consumeSpendBuff } from '../services/buffService.js';
import { consumePityForNewGame } from '../services/blockStackPityState.js';
import { recordIndividualTransaction } from '../services/individualTransactionService.js';
import { PRIZE_NAMES } from '../services/lotteryService.js';
import { scheduleSpentRoleSync } from '../services/spentRoleService.js';
import {
  buildBlockStackComponents,
  buildBlockStackEmbed,
} from '../ui/blockStackEmbeds.js';

const COMMAND = '!抽积木';
const START_COST = new Prisma.Decimal(49);
const SYSTEM_ID = process.env.BLOCK_STACK_SYSTEM_ID ?? 'block-stack-system';
const BOT_AVATAR_PATH = path.resolve(process.cwd(), 'src', 'img', 'botAvatar.jpg');
const LEGACY_BLOCK_STACK_VOUCHER_NAME = '抽积木代金券';
const BLOCK_STACK_POINT_SHOP_SKUS = ['BLOCK_STACK_VOUCHER'] as const;

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

      const mentionMatch = content.match(/<@!?(\d+)>/);
      const targetCreatorId = mentionMatch?.[1] ?? msg.author.id;

      const result = await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.pointShopGrant.updateMany({
          where: {
            discordUserId: msg.author.id,
            deliveryType: PointShopDeliveryType.COUPON,
            deliveryStatus: PointShopDeliveryStatus.DELIVERED,
            couponStatus: CouponStatus.ACTIVE,
            itemSku: { in: [...BLOCK_STACK_POINT_SHOP_SKUS] },
            expiresAt: { lte: now },
          },
          data: { couponStatus: CouponStatus.EXPIRED },
        });

        const freePointShopVoucher = await tx.pointShopGrant.findFirst({
          where: {
            discordUserId: msg.author.id,
            deliveryType: PointShopDeliveryType.COUPON,
            deliveryStatus: PointShopDeliveryStatus.DELIVERED,
            couponStatus: CouponStatus.ACTIVE,
            itemSku: { in: [...BLOCK_STACK_POINT_SHOP_SKUS] },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
          select: { id: true },
        });

        if (freePointShopVoucher) {
          await tx.pointShopGrant.update({
            where: { id: freePointShopVoucher.id },
            data: {
              couponStatus: CouponStatus.USED,
              consumedAt: now,
              consumeAmount: START_COST,
              consumeTargetId: msg.author.id,
            },
          });

          const game = await tx.blockStackGame.create({
            data: {
              creatorId: targetCreatorId,
              channelId: msg.channel.id,
              status: 'ACTIVE',
              totalRevenue: START_COST,
            },
          });
          return { status: 'ok' as const, game, spentCharged: false };
        }

        await tx.lotteryDraw.updateMany({
          where: {
            userId: msg.author.id,
            status: LotteryStatus.UNUSED,
            expiresAt: { lte: now },
            prize: { name: { in: [PRIZE_NAMES.BLOCK_STACK_VOUCHER, LEGACY_BLOCK_STACK_VOUCHER_NAME] } },
          },
          data: { status: LotteryStatus.EXPIRED },
        });

        const freeVoucher = await tx.lotteryDraw.findFirst({
          where: {
            userId: msg.author.id,
            status: LotteryStatus.UNUSED,
            expiresAt: { gt: now },
            prize: { name: { in: [PRIZE_NAMES.BLOCK_STACK_VOUCHER, LEGACY_BLOCK_STACK_VOUCHER_NAME] } },
          },
          orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
          select: { id: true },
        });

        if (freeVoucher) {
          await tx.lotteryDraw.update({
            where: { id: freeVoucher.id },
            data: {
              status: LotteryStatus.USED,
              consumeAt: now,
              requestId: msg.id,
              consumeAmount: START_COST,
              consumeTargetId: msg.author.id,
            },
          });

          const game = await tx.blockStackGame.create({
            data: {
              creatorId: targetCreatorId,
              channelId: msg.channel.id,
              status: 'ACTIVE',
              totalRevenue: START_COST,
            },
          });
          return { status: 'ok' as const, game, spentCharged: false };
        }

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
            creatorId: targetCreatorId,
            channelId: msg.channel.id,
            status: 'ACTIVE',
            totalRevenue: START_COST,
          },
        });
        return { status: 'ok' as const, game, spentCharged: true };
      });

      if (result.status === 'insufficient') {
        await sendToChannel(msg.channel, '余额不足！');
        return;
      }
      if (result.spentCharged) {
        scheduleSpentRoleSync(msg.author.id, { announceVipUpgrade: true });
      }

      const game = result.game!;
      consumePityForNewGame(game.id);
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
        await sent.edit({
          embeds: [embed],
          components,
          content: '等待玩家开工~',
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.error('[block-stack] clear @here failed:', err);
      }

      await prisma.blockStackGame.update({
        where: { id: game.id },
        data: {
          messageId: sent.id,
        },
      });
    } catch (err) {
      console.error('[block-stack] create failed:', err);
      try { await msg.reply('创建积木游戏失败，请稍后再试。'); } catch {}
    }
  });
}
