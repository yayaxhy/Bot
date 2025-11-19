import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { MemberStatus } from '@prisma/client';
import prisma from '../db/prisma.js';
import { isCashAdmin } from './cash.js';

export const registerPeiwanCommand = new SlashCommandBuilder()
  .setName('录入陪玩')
  .setDescription('校验陪玩数据，确保 Member/PEIWAN 一致性')
  .addUserOption((option) =>
    option.setName('陪玩').setDescription('Discord 用户').setRequired(true)
  );

export async function handleRegisterPeiwanSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '录入陪玩') return;

  if (!isCashAdmin(i)) {
    await i.reply({ content: '❌ 你没有权限使用该命令。', ephemeral: true });
    return;
  }

  const target = i.options.getUser('陪玩', true);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const member = await tx.member.upsert({
        where: { discordUserId: target.id },
        update: {},
        create: { discordUserId: target.id },
        select: { discordUserId: true, VIPRoleOptOut: true },
      });

      await tx.member.update({
        where: { discordUserId: member.discordUserId },
        data: { status: MemberStatus.PEIWAN, VIPRoleOptOut: member.VIPRoleOptOut ?? false },
      });

      await tx.$executeRaw`
        UPDATE "Member"
        SET "VIPRoleOptOut" = false
        WHERE "discordUserId" = ${member.discordUserId}
          AND ("VIPRoleOptOut"::text NOT IN ('true','false'));
      `;

      const peiwan = await tx.pEIWAN.findUnique({
        where: { discordUserId: target.id },
        select: { PEIWANID: true, defaultQuotationCode: true },
      });
      if (!peiwan) {
        throw new Error('尚未在陪玩表中找到该用户，请先写入数据。');
      }

      return peiwan;
    });

    await i.reply({
      content: `<@${target.id}> 的陪玩资料已校验，编号：${result.PEIWANID}`,
      ephemeral: false,
    });
  } catch (err: any) {
    const message =
      typeof err?.message === 'string'
        ? err.message
        : '录入失败，请检查编号或数据库约束。';
    console.error('[registerPeiwan] error', err);
    await i.reply({ content: `❌ ${message}`, ephemeral: true });
  }
}
