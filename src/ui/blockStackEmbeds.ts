import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { BlockStackGame } from '@prisma/client';

export function calcBlockStackCollapseChance(totalBlocks: number): number {
  const blocks = Math.max(0, totalBlocks);
  let chance = 0.03; // base 3%

  // <= 50: every 10 blocks +0.75%
  const tier1Blocks = Math.min(blocks, 50);
  chance += Math.floor(tier1Blocks / 10) * 0.015;

  // 50~100: every 5 blocks +0.75%
  if (blocks > 50) {
    const tier2Blocks = Math.min(blocks, 100) - 50;
    chance += Math.floor(tier2Blocks / 5) * 0.0165;
  }

  // > 100: every 10 blocks +3%
  if (blocks > 100) {
    const tier3Blocks = blocks - 100;
    chance += Math.floor(tier3Blocks / 10) * 0.03;
  }

  return Math.min(chance, 0.2);
}

function formatPercent(chance: number) {
  const pct = Math.round(chance * 100);
  return `${pct}%`;
}

function statusLabel(status: BlockStackGame['status']) {
  if (status === 'ACTIVE') return '正在叠叠乐';
  if (status === 'COLLAPSED') return '塌啦';
  if (status === 'SETTLED') return '已结算';
  return status;
}

function actionLabel(action?: BlockStackGame['collapsedByAction'] | null) {
  if (action === 'SINGLE') return '抽一根';
  if (action === 'TEN') return '捣蛋十连';
  if (action === 'SETTLE') return '收菜结算';
  return action ?? '未知';
}

function chunkActionLines(lines: string[], maxLen = 1000): string[] {
  const chunks: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const line of lines) {
    const nextLen = len + line.length + (buf.length ? 1 : 0);
    if (nextLen > maxLen && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [line];
      len = line.length;
      continue;
    }
    buf.push(line);
    len = nextLen;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

export function buildBlockStackEmbed(
  game: BlockStackGame,
  opts?: { lastAction?: string; actionLines?: string[] }
) {
  const embed = new EmbedBuilder()
    .setTitle('叠叠乐小积木')
    .setColor(0xD4AF37)
    .setThumbnail('attachment://botAvatar.jpg')
    .setDescription(
      '点击【抽积木】，免费帮他助力；抽积木过程中\n' +
      '可能导致塌方，变成随机红包雨掉落。\n' +
      '点击【捣蛋十连】，付费10锦鲤币化身小小捣蛋鬼\n' +
      '有机会拿走所有奖励！\n' +
      '发起人可以点击【收菜结算】，落袋为安！\n'+
      '\n' +
      '发送 !抽积木 @对方 可以为TA开启游戏\n' 
    )
    .addFields(
      { name: '发起人', value: `<@${game.creatorId}>`, inline: true },
      { name: '状态', value: statusLabel(game.status), inline: true },
      { name: '当前层数', value: `${game.totalBlocks}`, inline: true }
    );



  if (game.status === 'COLLAPSED') {
    // no extra fields
  }

  if (game.status === 'SETTLED' && game.settledAmount) {
    embed.addFields({
      name: '结算奖励',
      value: `发起人获得 ¥${game.settledAmount.toString()}`,
    });
  }

  if (opts?.actionLines?.length) {
    const chunks = chunkActionLines(opts.actionLines);
    chunks.forEach((value, idx) => {
      const name = idx === 0 ? '叠叠记录' : `叠叠记录(${idx + 1})`;
      embed.addFields({ name, value });
    });
  } else if (opts?.lastAction) {
    embed.addFields({ name: '最新动作', value: `**${opts.lastAction}**` });
  }

  return embed;
}

export function buildBlockStackComponents(game: BlockStackGame) {
  if (game.status !== 'ACTIVE') {
    return [];
  }
  const disabled = false;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`blockstack:draw1:${game.id}`)
      .setLabel('抽积木')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`blockstack:draw10:${game.id}`)
      .setLabel('捣蛋十连')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`blockstack:settle:${game.id}`)
      .setLabel('收菜结算')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled)
  );

  return [row];
}
