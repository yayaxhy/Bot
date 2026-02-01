import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Prisma, MemberStatus } from '@prisma/client';
import prisma from '../db/prisma.js';
import { isCashAdmin } from './cash.js';
import { recordIndividualTransaction } from '../services/individualTransactionService.js';

const REASON_CHOICES = [
  { name: '公会成本', value: '公会成本' },
  { name: 'VIP福利', value: 'VIP福利' },
  { name: '老板赔偿', value: '老板赔偿' },
  { name: '充值返现', value: '充值返现' },
  { name: '其他', value: '其他' },
] as const;

export const giftSlashCommand = new SlashCommandBuilder()
  .setName('gift')
  .setDescription('公会赠送/补贴，增加用户余额并记录支出')
  .addNumberOption((option) =>
    option
      .setName('金额')
      .setDescription('增加的金额')
      .setRequired(true)
      .setMinValue(0.01)
  )
  .addUserOption((option) =>
    option
      .setName('用户')
      .setDescription('要赠送的用户')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('原因')
      .setDescription('支出类型')
      .setRequired(true)
      .addChoices(...REASON_CHOICES)
  );

export async function handleGiftSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== 'gift') return;

  if (!isCashAdmin(i)) {
    await i.reply({ content: '❌ 你没有权限使用该命令。', ephemeral: true });
    return;
  }

  const amountRaw = i.options.getNumber('金额', true);
  const target = i.options.getUser('用户', true);
  const reason = i.options.getString('原因', true);

  if (!amountRaw || amountRaw <= 0) {
    await i.reply({ content: '金额必须为正数。', ephemeral: true });
    return;
  }
  const amount = new Prisma.Decimal(amountRaw);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.member.upsert({
        where: { discordUserId: target.id },
        create: { discordUserId: target.id },
        update: {},
      });

      const peiwan = await tx.pEIWAN.findUnique({
        where: { discordUserId: target.id },
        select: { PEIWANID: true },
      });

      const before = await tx.member.findUnique({
        where: { discordUserId: target.id },
        select: { totalBalance: true },
      });
      const balanceBefore = new Prisma.Decimal(before?.totalBalance ?? 0);
      const balanceAfter = balanceBefore.add(amount);

      await tx.member.update({
        where: { discordUserId: target.id },
        data: {
          recharge: { increment: amount },
          totalBalance: { increment: amount },
          ...(peiwan ? { status: MemberStatus.PEIWAN } : {}),
        },
      });

      await tx.expense.create({
        data: {
          amount,
          operatorId: i.user.id,
          targetId: target.id,
          reason,
        },
      });

      await recordIndividualTransaction(tx, {
        discordId: target.id,
        thirdPartydiscordId: i.user.id,
        balanceBefore,
        amountChange: amount,
        balanceAfter,
        typeOfTransaction: reason,
      });

      return { balanceAfter };
    });

    await i.reply({
      content: `已为 <@${target.id}> 增加余额 ${amount.toString()}，当前余额：${result.balanceAfter.toString()}`,
      ephemeral: false,
    });
  } catch (err) {
    console.error('[giftSlash] error', err);
    await i.reply({ content: '❌ 赠送失败，请稍后再试。', ephemeral: true });
  }
}
