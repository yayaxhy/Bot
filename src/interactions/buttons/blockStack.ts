import { ButtonInteraction } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../db/prisma.js';
import {
  buildBlockStackComponents,
  buildBlockStackEmbed,
  calcBlockStackCollapseChance,
} from '../../ui/blockStackEmbeds.js';
import { round2 } from '../../lib/money.js';
import { splitIncomeRecharge } from '../../lib/balanceMath.js';
import { recordIndividualTransaction } from '../../services/individualTransactionService.js';
import { suppressRechargeNotifications } from '../../services/rechargeNotifyConfig.js';
import {
  bindEnvelopeMessage,
  buildRedEnvelopeMessagePayload,
  createSystemRedEnvelope,
  scheduleRedEnvelopeExpiration,
  CLAIM_EMOJI_REACTION,
} from '../../services/redEnvelopeService.js';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);
const DRAW10_REVENUE = new Prisma.Decimal(10);
const DRAW10_COST = new Prisma.Decimal(10);
const MAX_ACTION_LINES = 50;

type ActionCacheEntry = {
  totalEntries: number;
  lines: string[];
};
const actionLineCache = new Map<string, ActionCacheEntry>();

type ActionKind = 'draw1' | 'draw10' | 'settle';

function parseCustomId(customId: string): { action: ActionKind; gameId: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'blockstack') return null;
  const action = parts[1] as ActionKind;
  if (!['draw1', 'draw10', 'settle'].includes(action)) return null;
  return { action, gameId: parts[2] };
}

function rollCollapse(totalBlocks: number) {
  const chance = calcBlockStackCollapseChance(totalBlocks);
  const roll = Math.random();
  return { chance, roll, collapsed: roll < chance };
}

function resolveDisplayName(name?: string | null, fallback?: string | null) {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  if (fallback?.trim()) return fallback.trim();
  return '玩家';
}

function trimActionLines(lines: string[]) {
  return lines.length > MAX_ACTION_LINES ? lines.slice(-MAX_ACTION_LINES) : lines;
}

function materializeDisplayLines(entry: ActionCacheEntry): string[] {
  const omitted = Math.max(0, entry.totalEntries - entry.lines.length);
  if (omitted <= 0) return entry.lines;
  return [`…前 ${omitted} 条记录已省略`, ...entry.lines];
}

function formatDrawLine(
  row: { action: string; userId: string; blocksAdded: number },
  displayName?: string | null
) {
  const label = resolveDisplayName(displayName, row.userId);
  if (row.action === 'TEN') {
    return `😈 调皮的 ${label} 一次性抽出了 ${row.blocksAdded} 根积木`;
  }
  return `${label} 抽出 ${row.blocksAdded} 根积木`;
}

function buildCollapseSummaryLine(
  game: any,
  lastDraw?: { userId: string; blocksAdded: number } | null
): string | null {
  if (game.status !== 'COLLAPSED') return null;
  if (game.collapsedByAction === 'TEN' && game.collapseRewardGross && game.collapsedById) {
    return `💥 <@${game.collapsedById}> 搞破坏成功，获得全部收益${game.collapseRewardGross.toString()}。`;
  }
  if (lastDraw) {
    return `💥善良的 <@${lastDraw.userId}> 抽出 ${lastDraw.blocksAdded} 根积木导致积木塌方。`;
  }
  return null;
}

function buildSettledSummaryLine(game: any): string | null {
  if (game.status !== 'SETTLED' || !game.settledAmount) return null;
  return `🏆 积木已结算，恭喜<@${game.creatorId}>获得总收益${game.settledAmount.toString()}`;
}

function setActionCache(gameId: string, entry: ActionCacheEntry) {
  actionLineCache.set(gameId, {
    totalEntries: entry.totalEntries,
    lines: trimActionLines(entry.lines),
  });
}

function appendActionCache(gameId: string, additions: string[]) {
  if (!additions.length) return;
  const current = actionLineCache.get(gameId) ?? { totalEntries: 0, lines: [] };
  const merged = [...current.lines, ...additions];
  setActionCache(gameId, {
    totalEntries: current.totalEntries + additions.length,
    lines: merged,
  });
}

async function hydrateActionCache(game: any) {
  const [drawCount, latestRowsDesc] = await Promise.all([
    prisma.blockStackDraw.count({ where: { gameId: game.id } }),
    prisma.blockStackDraw.findMany({
      where: { gameId: game.id },
      orderBy: { createdAt: 'desc' },
      take: MAX_ACTION_LINES,
      select: { action: true, userId: true, blocksAdded: true },
    }),
  ]);
  const userIds = Array.from(new Set(latestRowsDesc.map((row) => row.userId)));
  const memberRows = userIds.length
    ? await prisma.member.findMany({
        where: { discordUserId: { in: userIds } },
        select: { discordUserId: true, serverDisplayName: true },
      })
    : [];
  const displayMap = new Map<string, string>();
  for (const row of memberRows) {
    if (row.serverDisplayName) displayMap.set(row.discordUserId, row.serverDisplayName);
  }

  const latestRows = latestRowsDesc.reverse();
  const lines = latestRows.map((row) => formatDrawLine(row, displayMap.get(row.userId)));
  const lastDraw = latestRows[latestRows.length - 1];
  const collapseSummary = buildCollapseSummaryLine(game, lastDraw);
  const settledSummary = buildSettledSummaryLine(game);
  if (collapseSummary) lines.push(collapseSummary);
  if (settledSummary) lines.push(settledSummary);

  const summaryCount = (collapseSummary ? 1 : 0) + (settledSummary ? 1 : 0);
  const entry: ActionCacheEntry = {
    totalEntries: drawCount + summaryCount,
    lines: trimActionLines(lines),
  };
  setActionCache(game.id, entry);
  return entry;
}

async function getActionLinesForDisplay(game: any, additions?: string[]) {
  let entry = actionLineCache.get(game.id);
  if (!entry) {
    entry = await hydrateActionCache(game);
  } else if (additions?.length) {
    appendActionCache(game.id, additions);
    entry = actionLineCache.get(game.id)!;
  }
  return materializeDisplayLines(entry);
}

async function updatePeiwanBalance(
  tx: Prisma.TransactionClient,
  userId: string,
  newBalance: Prisma.Decimal
) {
  const peiwan = await tx.pEIWAN.findUnique({
    where: { discordUserId: userId },
    select: { PEIWANID: true },
  });
  if (!peiwan) return;
  await tx.pEIWAN.update({
    where: { discordUserId: userId },
    data: { balance: newBalance },
  });
}

export async function handleBlockStackButton(i: ButtonInteraction) {
  const parsed = parseCustomId(i.customId ?? '');
  if (!parsed) return;

  const { action, gameId } = parsed;
  const actorId = i.user.id;
  const actorLabel = resolveDisplayName((i.member as any)?.displayName, i.user.username);
  const systemId = i.client.user?.id ?? process.env.BLOCK_STACK_SYSTEM_ID ?? 'block-stack-system';

  await i.deferUpdate();

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "BlockStackGame" WHERE id = ${gameId} FOR UPDATE`;
    const game = await tx.blockStackGame.findUnique({ where: { id: gameId } });
    if (!game) return { status: 'not_found' as const };
    if (game.status !== 'ACTIVE') return { status: 'ended' as const, game };

    if (action === 'settle') {
      if (game.creatorId !== actorId) {
        return { status: 'forbidden' as const, game };
      }
      await tx.member.upsert({
        where: { discordUserId: actorId },
        create: { discordUserId: actorId },
        update: {},
      });
      await suppressRechargeNotifications(tx);
      const amount = DEC(game.totalBlocks);
      const member = await tx.member.findUnique({
        where: { discordUserId: actorId },
        select: { totalBalance: true },
      });
      const balanceBefore = DEC(member?.totalBalance ?? 0);
      const balanceAfter = balanceBefore.add(amount);
      await tx.member.update({
        where: { discordUserId: actorId },
        data: {
          recharge: { increment: amount },
          totalBalance: { increment: amount },
        },
      });
      await updatePeiwanBalance(tx, actorId, balanceAfter);

      await recordIndividualTransaction(tx, {
        discordId: actorId,
        thirdPartydiscordId: systemId,
        balanceBefore,
        amountChange: amount,
        balanceAfter,
        typeOfTransaction: '积木结算收益',
      });

      const updated = await tx.blockStackGame.update({
        where: { id: gameId },
        data: {
          status: 'SETTLED',
          settledAt: new Date(),
          settledById: actorId,
          settledAmount: amount,
        },
      });
      return {
        status: 'settled' as const,
        game: updated,
        reply: `结算完成，发起人获得 ¥${amount.toString()}。`,
        settleLine: buildSettledSummaryLine(updated),
        actionMessage: `${actorLabel} 收菜结算，游戏结束`,
      };
    }

    if (action === 'draw1') {
      const player = await tx.blockStackPlayer.findUnique({
        where: { gameId_userId: { gameId, userId: actorId } },
        select: { singlePicked: true },
      });
      if (player?.singlePicked) {
        return { status: 'already' as const, game };
      }

      const blocks = Math.floor(Math.random() * 10) + 1;
      await tx.blockStackDraw.create({
        data: {
          gameId,
          userId: actorId,
          action: 'SINGLE',
          blocksAdded: blocks,
        },
      });

      await tx.blockStackPlayer.upsert({
        where: { gameId_userId: { gameId, userId: actorId } },
        create: { gameId, userId: actorId, singlePicked: true, singleBlocks: blocks },
        update: { singlePicked: true, singleBlocks: blocks },
      });

      const totalBlocks = game.totalBlocks + blocks;
      const collapse = rollCollapse(totalBlocks);

      const updatedGame = await tx.blockStackGame.update({
        where: { id: gameId },
        data: {
          totalBlocks,
          totalSingleDraws: { increment: 1 },
          ...(collapse.collapsed
            ? {
                status: 'COLLAPSED',
                collapsedAt: new Date(),
                collapsedById: actorId,
                collapsedByAction: 'SINGLE',
                collapseChance: DEC(collapse.chance),
                collapseRoll: DEC(collapse.roll),
              }
            : {}),
        },
      });

      const reply = collapse.collapsed
        ? `哎呀塌啦！你抽出 ${blocks} 根，当前总数 ${totalBlocks}。`
        : `你抽出 ${blocks} 根积木，当前总数 ${totalBlocks}。`;
      const actionLine = `${actorLabel} 抽出 ${blocks} 根积木`;
      const collapseLine = collapse.collapsed
        ? `💥善良的 <@${actorId}> 抽出 ${blocks} 根积木导致积木塌方。`
        : null;
      const actionMessage = collapse.collapsed
        ? `💥 ${actorLabel} 抽出了积木导致塌方`
        : `${actorLabel} 抽出了积木`;
      return {
        status: 'ok' as const,
        game: updatedGame,
        blocks,
        collapsed: collapse.collapsed,
        needsEnvelope: collapse.collapsed,
        reply,
        actionLine,
        collapseLine,
        actionMessage,
      };
    }

    // draw10
    await tx.member.upsert({
      where: { discordUserId: actorId },
      create: { discordUserId: actorId },
      update: {},
    });
    const payer = await tx.member.findUnique({
      where: { discordUserId: actorId },
      select: { income: true, recharge: true, totalBalance: true },
    });
    if (!payer) return { status: 'insufficient' as const, game };

    let incomePool = DEC(payer.income ?? 0);
    let rechargePool = DEC(payer.recharge ?? 0);
    const totalBalance = DEC(payer.totalBalance ?? 0);
    const knownPool = incomePool.add(rechargePool);
    const maxAvailable = knownPool.gt(totalBalance) ? knownPool : totalBalance;
    if (maxAvailable.lt(DRAW10_COST)) {
      return { status: 'insufficient' as const, game };
    }
    if (knownPool.lt(DRAW10_COST)) {
      const missing = DRAW10_COST.sub(knownPool);
      const extra = totalBalance.sub(knownPool);
      if (extra.lt(missing)) {
        return { status: 'insufficient' as const, game };
      }
      rechargePool = rechargePool.add(missing);
    }

    const split = splitIncomeRecharge(incomePool, rechargePool, DRAW10_COST);
    const incomeAfter = incomePool.sub(split.fromIncome);
    const rechargeAfter = rechargePool.sub(split.fromRecharge);
    const totalBalanceAfter = incomeAfter.add(rechargeAfter);

    await tx.member.update({
      where: { discordUserId: actorId },
      data: {
        income: incomeAfter,
        recharge: rechargeAfter,
        totalBalance: totalBalanceAfter,
      },
    });
    await updatePeiwanBalance(tx, actorId, totalBalanceAfter);

    await recordIndividualTransaction(tx, {
      discordId: actorId,
      thirdPartydiscordId: systemId,
      balanceBefore: split.totalBefore,
      amountChange: DRAW10_COST,
      balanceAfter: split.totalAfter,
      typeOfTransaction: '积木捣蛋鬼',
    });

    const blocks = 10;
    const totalBlocks = game.totalBlocks + blocks;
    const collapse = rollCollapse(totalBlocks);

    let reward: {
      userId: string;
      gross: Prisma.Decimal;
      net: Prisma.Decimal;
      transactionId?: string;
    } | null = null;

    if (collapse.collapsed) {
      await tx.member.upsert({
        where: { discordUserId: actorId },
        create: { discordUserId: actorId },
        update: {},
      });
      await suppressRechargeNotifications(tx);
      const member = await tx.member.findUnique({
        where: { discordUserId: actorId },
        select: { totalBalance: true, commissionRate: true },
      });
      let rate = DEC(member?.commissionRate ?? 0.75);
      if (rate.gt(1)) rate = DEC(1);
      if (rate.lt(0)) rate = DEC(0);
      const gross = DEC(totalBlocks);
      const net = round2(gross.mul(rate));

      const balanceBefore = DEC(member?.totalBalance ?? 0);
      const balanceAfter = balanceBefore.add(net);

      await tx.member.update({
        where: { discordUserId: actorId },
        data: {
          recharge: { increment: net },
          totalBalance: { increment: net },
        },
      });
      await updatePeiwanBalance(tx, actorId, balanceAfter);

      const txRecord = await recordIndividualTransaction(tx, {
        discordId: actorId,
        thirdPartydiscordId: systemId,
        balanceBefore,
        amountChange: net,
        balanceAfter,
        typeOfTransaction: '捣蛋鬼收益',
      });

      reward = { userId: actorId, gross, net, transactionId: txRecord.transactionId };
    }

    const updatedGame = await tx.blockStackGame.update({
      where: { id: gameId },
      data: {
        totalBlocks,
        totalTenDraws: { increment: 1 },
        totalRevenue: { increment: DRAW10_REVENUE },
        ...(collapse.collapsed
          ? {
              status: 'COLLAPSED',
              collapsedAt: new Date(),
              collapsedById: actorId,
              collapsedByAction: 'TEN',
              collapseChance: DEC(collapse.chance),
              collapseRoll: DEC(collapse.roll),
              ...(reward
                ? {
                    collapseRewardUserId: reward.userId,
                    collapseRewardGross: reward.gross,
                    collapseRewardNet: reward.net,
                    collapseRewardTransactionId: reward.transactionId,
                  }
                : {}),
            }
          : {}),
      },
    });

    await tx.blockStackDraw.create({
      data: {
        gameId,
        userId: actorId,
        action: 'TEN',
        blocksAdded: blocks,
      },
    });

    const reply = collapse.collapsed
      ? reward
        ? `🎉 搞破坏成功！你获得 ¥${reward.net.toString()}。`
        : `💥 积木塌啦！当前总数 ${totalBlocks}。`
      : `😈 你抽取了 10 根积木，当前总数 ${totalBlocks}。`;
    const actionLine = `😈 调皮的 ${actorLabel} 一次性抽出了 ${blocks} 根积木`;
    const collapseLine = collapse.collapsed
      ? reward
        ? `💥 <@${actorId}> 搞破坏成功，获得全部收益${reward.gross.toString()}。`
        : `💥善良的 <@${actorId}> 抽出 ${blocks} 根积木导致积木塌方。`
      : null;
    const actionMessage = collapse.collapsed
      ? reward
        ? `😈 ${actorLabel} 捣蛋成功`
        : `💥 ${actorLabel} 进行了捣蛋导致塌方`
      : `${actorLabel} 进行了捣蛋`;
    return {
      status: 'ok' as const,
      game: updatedGame,
      blocks,
      collapsed: collapse.collapsed,
      needsEnvelope: collapse.collapsed && !reward,
      reply,
      actionLine,
      collapseLine,
      actionMessage,
      reward,
    };
  });

  if (result.status === 'not_found') {
    if (i.message && 'edit' in i.message) {
      await i.message.edit({ components: [] }).catch(() => {});
    }
    return;
  }
  if ((result as any).status === 'insufficient') {
    await i.followUp({ content: '余额不足！', ephemeral: true }).catch(() => {});
    return;
  }
  if (result.status === 'forbidden' || (result as any).status === 'already') {
    return;
  }

  const game = (result as any).game as any;
  if (game && i.message && 'edit' in i.message) {
    const additions: string[] = [];
    if ((result as any).actionLine) additions.push((result as any).actionLine);
    if ((result as any).collapseLine) additions.push((result as any).collapseLine);
    if ((result as any).settleLine) additions.push((result as any).settleLine);
    const actionLines = await getActionLinesForDisplay(game, additions);
    const embed = buildBlockStackEmbed(game, { actionLines });
    const components = buildBlockStackComponents(game);
    const actionMessage = (result as any).actionMessage;
    const content = actionMessage ? `${actionMessage}` : i.message.content;
    await i.message.edit({ embeds: [embed], components, content }).catch(() => {});
  }

  if ((result as any).status === 'settled') {
    const amount = game?.settledAmount?.toString?.() ?? '';
    if (amount) {
      i.user
        .send(`🎉 你太强啦！零失误从抽积木游戏获得了${amount}的收益`)
        .catch(() => {});
    }
  }

  if ((result as any).status === 'ok' && (result as any).reward?.net) {
    const amount = (result as any).reward.net.toString();
    i.user.send(`😈 搞破坏成功，获得全部收益${amount}`).catch(() => {});
  }

  if ((result as any).needsEnvelope && game) {
    try {
      const ratio = round2(DEC(0.3).add(DEC(Math.random()).mul(DEC(0.1))));
      const rawAmount = round2(DEC(game.totalBlocks).mul(ratio));
      const minAmount = DEC(10);
      const totalAmount = rawAmount.lt(minAmount) ? minAmount : rawAmount;
      const envelope = await createSystemRedEnvelope(
        {
          creatorId: systemId,
          totalAmount,
          count: 20,
          note: '积木塌掉红包',
          channelId: game.channelId,
        },
        prisma
      );

      await prisma.blockStackGame.update({
        where: { id: game.id },
        data: {
          collapseEnvelopeAmount: envelope.totalAmount,
        },
      });

      const channel = await i.client.channels.fetch(game.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const payload = buildRedEnvelopeMessagePayload({
        id: envelope.id,
        creatorId: envelope.creatorId,
        totalAmount: envelope.totalAmount,
        totalCount: envelope.totalCount,
        remainingCount: envelope.remainingCount,
        status: envelope.status,
        expiresAt: envelope.expiresAt,
        note: envelope.note ?? undefined,
        refundedAmount: envelope.refundedAmount ?? undefined,
      });

      if (!channel || typeof (channel as any).send !== 'function') return;
      const sent = await (channel as any).send({ ...payload });
      await bindEnvelopeMessage(envelope.id, { messageId: sent.id, channelId: sent.channelId }, prisma);

      try {
        await sent.react(CLAIM_EMOJI_REACTION);
      } catch (reactErr) {
        console.error('[block-stack] add reaction failed:', reactErr);
      }

      scheduleRedEnvelopeExpiration((globalThis as any).__CLIENT__ ?? i.client, {
        id: envelope.id,
        expiresAt: envelope.expiresAt,
      });

      const updated = await prisma.blockStackGame.findUnique({ where: { id: game.id } });

      if (updated && i.message && 'edit' in i.message) {
        const actionLines = await getActionLinesForDisplay(updated);
        const embed = buildBlockStackEmbed(updated, { actionLines });
        const components = buildBlockStackComponents(updated);
        const content = i.message.content;
        await i.message.edit({ embeds: [embed], components, content }).catch(() => {});
      }
    } catch (err) {
      console.error('[block-stack] create envelope failed:', err);
    }
  }
}
