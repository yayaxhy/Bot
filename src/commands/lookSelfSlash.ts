import { ChatInputCommandInteraction, SlashCommandBuilder, userMention } from 'discord.js';
import { MemberStatus, PeiwanReviewDisplayMode } from '@prisma/client';
import prisma from '../db/prisma.js';
import { mapPeiwanRoleLabels, resolvePeiwanEmbedTitle, sent_MP_embed } from '../ui/orderEmbeds.js';

export const lookSelfCommand = new SlashCommandBuilder()
  .setName('看看自己')
  .setDescription('查看自己的陪玩名片');

export async function handleLookSelfSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '看看自己') return;

  const discordUserId = i.user.id;
  const peiwan = await prisma.pEIWAN.findUnique({
    where: { discordUserId },
    include: {
      member: { select: { status: true } },
      gameProfiles: {
        select: {
          gameCode: true,
          tier: true,
          sourceRoleId: true,
        },
      },
    },
  });

  if (!peiwan || peiwan.member?.status !== MemberStatus.PEIWAN) {
    await i.reply({ content: '未找到你的陪玩资料。', ephemeral: true });
    return;
  }

  const deletionRecord = await prisma.peiwanDeletion.findUnique({
    where: { peiwanId: peiwan.PEIWANID },
    select: { peiwanId: true },
  });
  if (deletionRecord) {
    await i.reply({ content: '你的陪玩资料当前不可展示。', ephemeral: true });
    return;
  }

  const reviewRows = await prisma.peiwanReview.findMany({
    where: {
      peiwanDiscordId: discordUserId,
      displayMode: { in: [PeiwanReviewDisplayMode.ANONYMOUS, PeiwanReviewDisplayMode.REALNAME] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      content: true,
      displayMode: true,
      reviewerName: true,
    },
  });

  const bossReviews = reviewRows.map((row) => {
    const reviewText = String(row.content ?? '').trim();
    if (row.displayMode === 'ANONYMOUS') {
      return `匿名老板评语：${reviewText}`;
    }
    const reviewerName = (row.reviewerName ?? '').trim();
    if (reviewerName) {
      return `老板${reviewerName}评语：${reviewText}`;
    }
    return `老板评语：${reviewText}`;
  });

  const peiwanType = resolvePeiwanEmbedTitle(peiwan.type, peiwan.gameProfiles);
  const peiwanRoleLabels = mapPeiwanRoleLabels(peiwan.gameProfiles);
  const { embed } = sent_MP_embed(
    peiwanType,
    peiwan.PEIWANID,
    userMention(discordUserId),
    peiwanRoleLabels,
    '',
    peiwan.MP_url ?? null,
    bossReviews,
    null,
    null,
    null,
    null,
  );

  await i.reply({
    embeds: [embed],
    ephemeral: false,
  });
}
