import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { ScratchPrizeType } from '@prisma/client';
import { getScratchPrizeLabel } from '../services/scratchService.js';

const SCRATCH_EMBED_COLOR = 0xD4AF37;
const SCRATCH_EMBED_THUMBNAIL_URL =
  'https://cdn.discordapp.com/attachments/1445864521343439019/1469920031272992768/2.gif?ex=69896935&is=698817b5&hm=165f9dc19c804078f011b9d78e725a6dccf267c3f4082b8b8a7d36a0f5d07d3d';

export function buildScratchRevealButton(ticketId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`scratch:reveal:${ticketId}`)
      .setLabel('刮开')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

export function buildScratchPendingEmbed(params: {
  code: string;
  buyerId: string;
  amount: string;
}) {
  return new EmbedBuilder()
    .setColor(SCRATCH_EMBED_COLOR)
    .setTitle('刮刮乐')
    .setThumbnail(SCRATCH_EMBED_THUMBNAIL_URL)
    .setDescription(`花费了${params.amount}，获得了 ${params.code} 号刮刮乐`)
    .addFields(
      { name: '购卡用户', value: `<@${params.buyerId}>`, inline: true },
      { name: '操作', value: '点击下方按钮进行刮开', inline: false },
    );
}

function buildPrizeText(prizeType: ScratchPrizeType, prizeAmount: string) {
  if (prizeType === ScratchPrizeType.THANKS) {
    return '谢谢惠顾';
  }
  return `¥${prizeAmount}`;
}

export function buildScratchRevealedEmbed(params: {
  code: string;
  buyerId: string;
  prizeType: ScratchPrizeType;
  prizeAmount: string;
}) {
  const label = getScratchPrizeLabel(params.prizeType);
  const isThanks = params.prizeType === ScratchPrizeType.THANKS;
  const prizeText = buildPrizeText(params.prizeType, params.prizeAmount);

  const embed = new EmbedBuilder()
    .setColor(SCRATCH_EMBED_COLOR)
    .setTitle('刮刮乐结果')
    .setThumbnail(SCRATCH_EMBED_THUMBNAIL_URL)
    .setDescription(
      isThanks
        ? `${params.code} 号刮刮乐已刮开，谢谢惠顾`
        : `${params.code} 号刮刮乐已刮开，恭喜获得${prizeText}奖励`,
    );

  embed.addFields({ name: '购卡用户', value: `<@${params.buyerId}>`, inline: true });

  return embed;
}
