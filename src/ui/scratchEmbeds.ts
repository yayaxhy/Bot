import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { ScratchPrizeType } from '@prisma/client';
import { getScratchCodeExample, getScratchPrizeLabel } from '../services/scratchService.js';

const SCRATCH_EMBED_COLOR = 0xD4AF37;
const SCRATCH_EMBED_THUMBNAIL_URL =
  'https://cdn.discordapp.com/attachments/1445864521343439019/1469920031272992768/2.gif?ex=69896935&is=698817b5&hm=165f9dc19c804078f011b9d78e725a6dccf267c3f4082b8b8a7d36a0f5d07d3d';
const SCRATCH_PENDING_IMAGE_URL =
  'https://media.discordapp.net/attachments/1445864521343439019/1470678417971085412/7e0841ec8730be350fed995911ec0ee2.png?ex=698cd442&is=698b82c2&hm=67071052c42e58fd660b16afd5a8b5b322d0b93faedf524b7c76f76b87474df3&=&format=webp&quality=lossless&width=2249&height=1265';
const SCRATCH_REVEAL_IMAGE_BY_TYPE: Partial<Record<ScratchPrizeType, string>> = {
  [ScratchPrizeType.THANKS]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470668481241550889/014a4f08e851b85f.png?ex=698ccb01&is=698b7981&hm=eeb982c3d6377f61622a797fd60de7e5b747fb2e257e92ba4b25bb155a9736df&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P5]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470657275730591825/5_1.png?ex=698cc092&is=698b6f12&hm=37ac7c82a13f6ca511f5cf787a7a7be5bcddb0133c88884952b0347dcee2ebcc&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P20]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470658217695776798/20.png?ex=698cc172&is=698b6ff2&hm=7a2d75236af138781865e7cd63324af0ab8c37e3e01b29f33ae6020d57b80903&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P30]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470658556553334919/30.png?ex=698cc1c3&is=698b7043&hm=818194162808c08536383ebd4f6cffe9d9a0dc147aa79612e7cf741e7b7e93f6&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P50]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470658936989417512/50.png?ex=698cc21e&is=698b709e&hm=a251553af2f49dadd9487d91b8b851389be1fdf9be8d0711f995411ff186c74e&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P99]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470661628226830386/99.png?ex=698cc49f&is=698b731f&hm=bfeff945fc2cc92e85813f93beda0fed08132f87c7f4fc21ac139421eec9056b&=&format=webp&quality=lossless&width=2249&height=1265',
  [ScratchPrizeType.P200]:
    'https://media.discordapp.net/attachments/1445864521343439019/1470666558782181480/150.png?ex=698cc937&is=698b77b7&hm=d7246c49794e8ed53f397bf948ae67a7afb9100512255dc52200fb96f54db6a4&=&format=webp&quality=lossless&width=2249&height=1265',
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
  topPrizeLabel?: string;
  topPrizeRemaining?: number;
}) {
  const codeExample = getScratchCodeExample(3);
  const embed = new EmbedBuilder()
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
          `输入 !刮刮乐（随机一张） 或 !刮刮乐 ${codeExample}\n输入 !刮刮乐 @对方 或 !刮刮乐 ${codeExample} @对方 送给TA一张你的心意🩷`,
        inline: false,
      },
      { name: '操作', value: '点击下方按钮进行刮开', inline: false },
    );
  if (typeof params.topPrizeRemaining === 'number') {
    const label = params.topPrizeLabel ? `¥${params.topPrizeLabel}` : '最大奖';
    embed.addFields({
      name: '最大奖剩余',
      value: `${label}，还剩 ${params.topPrizeRemaining} 张`,
      inline: false,
    });
  }
  return embed;
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
  topPrizeLabel?: string;
  topPrizeRemaining?: number;
}) {
  const codeExample = getScratchCodeExample(3);
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
      `输入 !刮刮乐（随机一张） 或 !刮刮乐 ${codeExample}\n输入 !刮刮乐 @对方 或 !刮刮乐 ${codeExample} @对方 送给TA一张你的心意🩷`,
    inline: false,
  });
  if (typeof params.topPrizeRemaining === 'number') {
    const label = params.topPrizeLabel ? `¥${params.topPrizeLabel}` : '最大奖';
    embed.addFields({
      name: '最大奖剩余',
      value: `${label}，还剩 ${params.topPrizeRemaining} 张`,
      inline: false,
    });
  }

  return embed;
}
