import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { getScratchInventory } from '../services/scratchService.js';

const PAGE_SIZE = 40;
const STOCK_BUTTON_PREFIX = 'scratchstock:go:';

function chunkCodes(codes: string[], size = 10) {
  const rows: string[] = [];
  for (let i = 0; i < codes.length; i += size) {
    rows.push(codes.slice(i, i + size).join(' '));
  }
  return rows;
}

function parseStockButton(customId: string | null | undefined) {
  if (!customId || !customId.startsWith(STOCK_BUTTON_PREFIX)) return null;
  const parts = customId.split(':');
  if (parts.length !== 4) return null;
  const page = Number.parseInt(parts[2], 10);
  const ownerId = parts[3];
  if (!Number.isInteger(page) || page < 1 || !ownerId) return null;
  return { page, ownerId };
}

function buildStockButtons(page: number, totalPages: number, ownerId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${STOCK_BUTTON_PREFIX}${Math.max(1, page - 1)}:${ownerId}`)
        .setLabel('上一页')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`${STOCK_BUTTON_PREFIX}${Math.min(totalPages, page + 1)}:${ownerId}`)
        .setLabel('下一页')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages),
    ),
  ];
}

async function buildScratchStockPayload(page: number, ownerId: string) {
  const result = await getScratchInventory(page, PAGE_SIZE);
  const embed = new EmbedBuilder().setColor(0xD4AF37).setTitle('刮刮乐库存');

  if (result.unsold === 0) {
    embed.setDescription('当前刮刮乐已售罄。').addFields(
      { name: '总数量', value: `${result.total}`, inline: true },
      { name: '已售', value: `${result.sold}`, inline: true },
      { name: '未售', value: `${result.unsold}`, inline: true },
    );
    return { embeds: [embed], components: [] as ActionRowBuilder<ButtonBuilder>[] };
  }

  const codeRows = chunkCodes(result.codes);
  embed
    .setDescription(codeRows.join('\n'))
    .addFields(
      { name: '未售', value: `${result.unsold}`, inline: true },
      { name: '页码', value: `${result.page}/${result.totalPages}`, inline: true },
      { name: '购买方式', value: '!刮刮乐 或 !刮刮乐 G003', inline: false },
    );

  return {
    embeds: [embed],
    components: buildStockButtons(result.page, result.totalPages, ownerId),
  };
}

export const scratchStockCommand = new SlashCommandBuilder()
  .setName('刮刮乐库存')
  .setDescription('查看当前可用的刮刮乐号码')
  .addIntegerOption((option) =>
    option
      .setName('页码')
      .setDescription('页码，从 1 开始')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(200),
  );

export async function handleScratchStockSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '刮刮乐库存') return;

  const page = i.options.getInteger('页码') ?? 1;
  try {
    await i.deferReply({ ephemeral: false });
    const payload = await buildScratchStockPayload(page, i.user.id);
    await i.editReply(payload);
  } catch (err) {
    console.error('[scratch-stock] error:', err);
    if (i.deferred || i.replied) {
      await i.editReply('查询库存失败，请稍后再试。').catch(() => {});
    } else {
      await i.reply({ content: '查询库存失败，请稍后再试。', ephemeral: true }).catch(() => {});
    }
  }
}

export async function handleScratchStockButton(i: ButtonInteraction) {
  const parsed = parseStockButton(i.customId);
  if (!parsed) return;

  await i.deferUpdate().catch(() => {});
  if (i.user.id !== parsed.ownerId) return;

  try {
    const payload = await buildScratchStockPayload(parsed.page, parsed.ownerId);
    await i.message.edit(payload).catch(() => {});
  } catch (err) {
    console.error('[scratch-stock] button error:', err);
  }
}
