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
const SCRATCH_PENDING_IMAGE_URL =
  'https://media.discordapp.net/attachments/1445864521343439019/1470497390036386049/7d31db6718f4267f.png?ex=698b82ea&is=698a316a&hm=495484fb6b4a6eb370bf8bc92a6ef7e2b5f5e02a11b956972f4ae65b70bbdbe5&=&format=webp&quality=lossless&width=2249&height=1265';
const SCRATCH_REVEAL_IMAGE_BY_TYPE: Partial<Record<ScratchPrizeType, string>> = {
  [ScratchPrizeType.THANKS]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470536534137504012/image.png?ex=698ba75e&is=698a55de&hm=8e166d51a49d9cb325858e4275c34313d5d4b82517f7256b893ad46e6c9d6126&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P5]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470542058744709161/image.png?ex=698bac84&is=698a5b04&hm=25cf9f38b340e950c6bc75065724ed11c8f0e148ff516512889040df0121a788&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P20]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470542099236655219/image.png?ex=698bac8d&is=698a5b0d&hm=5f1c9e1e951c8b21b44d0b91e6a757fed4ceaf7728855c4af2be59889ce93d55&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P30]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470542159420850510/image.png?ex=698bac9c&is=698a5b1c&hm=7d579989c791ca72209fb89cc98357fccfb803cba0acbc5043df95679e725522&=&format=webp&quality=lossless&width=825&height=464',
  [ScratchPrizeType.P50]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470542480922382468/image.png?ex=698bace8&is=698a5b68&hm=639b39d91c2a23b210ec378993322dc48bbe4dff2388bd9873d39d4f50e7f378&=&format=webp&quality=lossless&width=825&height=464',
  [ScratchPrizeType.P99]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470542427235418182/image.png?ex=698bacdc&is=698a5b5c&hm=8774afda59ba1ffd2121728c9da6cdcf7253e1c86d8d52d4cfec2a8b762386dd&=&format=webp&quality=lossless&width=825&height=464',
  [ScratchPrizeType.P200]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470536677251350720/image.png?ex=698ba781&is=698a5601&hm=200c37c959d755f9ad4e8a424135d41d53a03250c61f43379e2f6926e548792a&=&format=webp&quality=lossless&width=2249&height=1265',
};

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
    .setImage(SCRATCH_PENDING_IMAGE_URL)
    .setDescription(`花费了${params.amount}，获得了 ${params.code} 号刮刮乐`)
    .addFields(
      { name: '购卡用户', value: `<@${params.buyerId}>`, inline: true },
      {
        name: '购买方式',
        value:
          '输入 !刮刮乐（随机一张） 或 !刮刮乐 G003\n输入 !刮刮乐 @对方 或 !刮刮乐 G003 @对方 送给TA一张你的心意🩷',
        inline: false,
      },
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
    .setImage(SCRATCH_REVEAL_IMAGE_BY_TYPE[params.prizeType] ?? SCRATCH_PENDING_IMAGE_URL)
    .setDescription(
      isThanks
        ? `${params.code} 号刮刮乐已刮开，谢谢惠顾`
        : `${params.code} 号刮刮乐已刮开，恭喜获得${prizeText}奖励`,
    );

  embed.addFields({ name: '购卡用户', value: `<@${params.buyerId}>`, inline: true });
  embed.addFields({
    name: '购买方式',
    value:
      '输入 !刮刮乐（随机一张） 或 !刮刮乐 G003\n输入 !刮刮乐 @对方 或 !刮刮乐 G003 @对方 送给TA一张你的心意🩷',
    inline: false,
  });

  return embed;
}
