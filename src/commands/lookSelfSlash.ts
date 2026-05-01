import { ChatInputCommandInteraction, SlashCommandBuilder, userMention } from 'discord.js';
import { MemberStatus, PeiwanReviewDisplayMode } from '@prisma/client';
import prisma from '../db/prisma.js';
import { formatBossReviews } from '../services/peiwanReviewDisplayService.js';
import { buildStoredVoicePreviewAttachment } from '../services/peiwanVoicePreviewService.js';
import {
  buildGiftingSelect,
  DEFAULT_GIFTS,
  mapPeiwanRoleLabels,
  resolvePeiwanEmbedTitle,
  sent_MP_embed,
} from '../ui/orderEmbeds.js';

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
      reviewerDiscordId: true,
      reviewerName: true,
    },
  });

  const bossReviews = await formatBossReviews(i.guild, reviewRows);

  const peiwanType = resolvePeiwanEmbedTitle(peiwan.type, peiwan.gameProfiles);
  const peiwanRoleLabels = mapPeiwanRoleLabels(peiwan.gameProfiles);
  const realnameGiftBox = buildGiftingSelect('REALNAME', DEFAULT_GIFTS as Array<{ GiftName: string; price: number }>);
  const voicePreviewUrl = peiwan.voicePreviewUrl ?? null;
  const voicePreviewAttachment = voicePreviewUrl
    ? await buildStoredVoicePreviewAttachment({
        url: voicePreviewUrl,
        filename: peiwan.voicePreviewFilename ?? null,
      }).catch((err) => {
        console.error('[lookSelf] build voice preview attachment failed:', err);
        return null;
      })
    : null;
  const { embed, components } = sent_MP_embed(
    peiwanType,
    peiwan.PEIWANID,
    userMention(discordUserId),
    peiwanRoleLabels,
    '',
    peiwan.MP_url ?? null,
    Boolean(voicePreviewUrl),
    bossReviews,
    null,
    null,
    realnameGiftBox,
    null,
  );

  await i.reply({
    ...(voicePreviewAttachment
      ? { files: [voicePreviewAttachment] }
      : voicePreviewUrl
        ? { content: `试听音频：${voicePreviewUrl}` }
        : {}),
    embeds: [embed],
    components,
    ephemeral: false,
  });
}
