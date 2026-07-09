import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import {
  LotteryError,
  LotteryFusionError,
  POOL_LABEL,
  performLotteryFusion,
} from '../services/lotteryService.js';
import {
  buildBotLotteryFusionRequestId,
  buildLotteryFusionSelectableGroups,
  clampLotteryFusionTargetCount,
  getDefaultLotteryFusionTargetCount,
  getLotteryFusionSelectableInventoryForDiscordUser,
  syncLotteryFusionSelection,
  takeLastSelectedSourceIdFromFusionGroup,
  takeNextSourceIdFromFusionGroup,
  type LotteryFusionSelectableGroup,
  type LotteryFusionSelectableItem,
} from '../services/lotteryFusionBotService.js';
import {
  buildLotteryFusionBotSuccessMessage,
  sendLotteryFusionSuccessDm,
} from '../services/lotteryFusionNotificationService.js';

type FusionCount = 3 | 4 | 6;

type LotteryFusionSession = {
  id: string;
  ownerDiscordUserId: string;
  targetCount: FusionCount;
  items: LotteryFusionSelectableItem[];
  groups: LotteryFusionSelectableGroup[];
  selectedSourceIds: string[];
  page: number;
  notice: string | null;
  expiresAt: number;
  isSubmitting: boolean;
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const GROUPS_PER_PAGE = 25;
const CMD_NAME = '重铸';
const CUSTOM_ID_PREFIX = 'lotteryfusion';
const RULE_META: Record<FusionCount, { title: string; eligibleLabel: string; detail: string }> = {
  3: {
    title: '3 个融合',
    eligibleLabel: '银色 / 金色',
    detail: '结果只会出银色或金色，最高金色',
  },
  4: {
    title: '4 个融合',
    eligibleLabel: '银色 / 金色 / 高级',
    detail: '结果只会出银色、金色或高级，最高高级',
  },
  6: {
    title: '6 个融合',
    eligibleLabel: '金色 / 高级 / 特殊',
    detail: '结果只会出金色、高级或特殊，不会出银色',
  },
};

const sessions = new Map<string, LotteryFusionSession>();

const buildSessionId = () => crypto.randomBytes(6).toString('hex');

const nowMillis = () => Date.now();

const pruneExpiredSessions = () => {
  const current = nowMillis();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= current) {
      sessions.delete(sessionId);
    }
  }
};

const touchSession = (session: LotteryFusionSession) => {
  session.expiresAt = nowMillis() + SESSION_TTL_MS;
};

const parseCustomId = (customId: string) => {
  if (!customId.startsWith(`${CUSTOM_ID_PREFIX}:`)) return null;
  const parts = customId.split(':');
  return parts.length >= 3 ? parts : null;
};

const formatShortDate = (value?: Date | null) => {
  if (!value) return '永不过期';
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getAvailableMaxFusionCount = (availableCount: number): FusionCount | null => {
  if (availableCount >= 6) return 6;
  if (availableCount >= 4) return 4;
  if (availableCount >= 3) return 3;
  return null;
};

const createSession = (params: {
  ownerDiscordUserId: string;
  items: LotteryFusionSelectableItem[];
}): LotteryFusionSession => {
  const session: LotteryFusionSession = {
    id: buildSessionId(),
    ownerDiscordUserId: params.ownerDiscordUserId,
    targetCount: getDefaultLotteryFusionTargetCount(params.items.length),
    items: params.items,
    groups: buildLotteryFusionSelectableGroups(params.items),
    selectedSourceIds: [],
    page: 0,
    notice: '同名券/奖品已按“名字 + 数量”聚合显示。',
    expiresAt: nowMillis() + SESSION_TTL_MS,
    isSubmitting: false,
  };
  sessions.set(session.id, session);
  return session;
};

const getPageCount = (session: LotteryFusionSession) =>
  Math.max(1, Math.ceil(session.groups.length / GROUPS_PER_PAGE));

const getCurrentPageGroups = (session: LotteryFusionSession) => {
  const pageCount = getPageCount(session);
  session.page = Math.min(Math.max(session.page, 0), pageCount - 1);
  const start = session.page * GROUPS_PER_PAGE;
  return session.groups.slice(start, start + GROUPS_PER_PAGE);
};

const getSelectedCountByGroup = (session: LotteryFusionSession) => {
  const groupBySourceId = new Map<string, LotteryFusionSelectableGroup>();
  for (const group of session.groups) {
    for (const sourceId of group.sourceIds) {
      groupBySourceId.set(sourceId, group);
    }
  }

  const counts = new Map<string, number>();
  for (const sourceId of session.selectedSourceIds) {
    const group = groupBySourceId.get(sourceId);
    if (!group) continue;
    counts.set(group.key, (counts.get(group.key) ?? 0) + 1);
  }
  return counts;
};

const summarizeSelectedGroups = (session: LotteryFusionSession) => {
  const counts = getSelectedCountByGroup(session);
  if (!counts.size) return '暂无';

  return session.groups
    .filter((group) => counts.has(group.key))
    .map((group) => {
      const selectedCount = counts.get(group.key) ?? 0;
      return `• ${group.prizeName} ×${selectedCount}`;
    })
    .join('\n');
};

const buildFusionPanelEmbed = (session: LotteryFusionSession) => {
  const pageCount = getPageCount(session);
  const selectedCount = session.selectedSourceIds.length;
  const rule = RULE_META[session.targetCount];
  const maxCount = getAvailableMaxFusionCount(session.items.length);
  const availabilityText = maxCount
    ? `当前共有 ${session.items.length} 个可重铸券/奖品，可进行最高 ${maxCount} 个融合`
    : '当前可重铸券/奖品不足 3 个';

  const embed = new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle('奖品重铸')
    .setDescription(
      [
        `规则：${rule.title}`,
        `结果范围：${rule.eligibleLabel}`,
        `说明：${rule.detail}`,
        availabilityText,
        session.notice ? `提示：${session.notice}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .addFields(
      {
        name: `已选 ${selectedCount}/${session.targetCount}`,
        value: summarizeSelectedGroups(session),
      },
      {
        name: '当前页状态',
        value: `第 ${session.page + 1}/${pageCount} 页，共 ${session.groups.length} 个分组`,
      },
    )
    .setFooter({ text: '开始重铸后会消耗所选券/奖品' });

  if (session.isSubmitting) {
    embed.setDescription('正在执行重铸，请稍候...');
  }

  return embed;
};

const buildCountButtons = (session: LotteryFusionSession) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...([3, 4, 6] as const).map((count) => {
      const enabled = session.items.length >= count && !session.isSubmitting;
      return new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:count:${count}:${session.id}`)
        .setLabel(`${count} 个融合`)
        .setStyle(session.targetCount === count ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!enabled);
    }),
  );

const buildControlButtons = (session: LotteryFusionSession) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:page:prev:${session.id}`)
      .setLabel('上一页')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page <= 0 || session.isSubmitting),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:page:next:${session.id}`)
      .setLabel('下一页')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page >= getPageCount(session) - 1 || session.isSubmitting),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:refresh:${session.id}`)
      .setLabel('刷新')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.isSubmitting),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:reset:${session.id}`)
      .setLabel('清空选择')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(session.isSubmitting || session.selectedSourceIds.length === 0),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:start:${session.id}`)
      .setLabel(session.isSubmitting ? '正在重铸...' : '开始重铸')
      .setStyle(ButtonStyle.Success)
      .setDisabled(
        session.isSubmitting ||
          session.selectedSourceIds.length !== session.targetCount ||
          !getAvailableMaxFusionCount(session.items.length),
      ),
  );

const buildAddSelectRow = (session: LotteryFusionSession) => {
  const selectedSet = new Set(session.selectedSourceIds);
  const pageGroups = getCurrentPageGroups(session)
    .map((group) => ({
      group,
      remainingCount: group.sourceIds.filter((sourceId) => !selectedSet.has(sourceId)).length,
    }))
    .filter((entry) => entry.remainingCount > 0);
  if (!pageGroups.length) return null;

  const remainingCapacity = Math.max(0, session.targetCount - session.selectedSourceIds.length);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:add:${session.id}`)
    .setPlaceholder('选择要加入重铸的券/奖品')
    .setMinValues(1)
    .setMaxValues(Math.min(remainingCapacity || 1, pageGroups.length, 5))
    .setDisabled(session.isSubmitting || remainingCapacity <= 0)
    .addOptions(
      pageGroups.map(({ group, remainingCount }) => {
        return {
          label: `${group.prizeName} ×${remainingCount}`,
          value: group.key,
          description: `${POOL_LABEL[group.pool]} · 最早到期 ${formatShortDate(group.earliestExpiresAt)}`,
          default: false,
        };
      }),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
};

const buildRemoveSelectRow = (session: LotteryFusionSession) => {
  const counts = getSelectedCountByGroup(session);
  if (!counts.size) return null;

  const selectedGroups = session.groups.filter((group) => counts.has(group.key));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:remove:${session.id}`)
    .setPlaceholder('取消已选的券/奖品')
    .setMinValues(1)
    .setMaxValues(Math.min(selectedGroups.length, 5))
    .setDisabled(session.isSubmitting)
    .addOptions(
      selectedGroups.map((group) => ({
        label: `${group.prizeName} ×${counts.get(group.key) ?? 0}`,
        value: group.key,
        description: `${POOL_LABEL[group.pool]} · 取消 1 个`,
        default: false,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
};

const buildFusionPanelPayload = (session: LotteryFusionSession) => {
  const components: Array<
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  > = [buildCountButtons(session), buildControlButtons(session)];
  const addRow = buildAddSelectRow(session);
  const removeRow = buildRemoveSelectRow(session);
  if (addRow) components.push(addRow);
  if (removeRow) components.push(removeRow);
  return {
    embeds: [buildFusionPanelEmbed(session)],
    components,
  };
};

const buildSuccessEmbed = (prizeName: string, poolLabel: string, expiresAt?: Date | null) =>
  new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle('重铸成功')
    .setDescription(buildLotteryFusionBotSuccessMessage(prizeName))
    .addFields(
      { name: '奖品名称', value: prizeName, inline: false },
      { name: '奖品等级', value: poolLabel, inline: true },
      { name: '有效期到', value: formatShortDate(expiresAt ?? null), inline: true },
    )
    .setTimestamp(new Date());

const buildUnavailableText = () =>
  '所选券或奖品状态已变化，列表已自动刷新，请重新选择';

const getFailureText = (error: unknown) => {
  if (error instanceof LotteryFusionError) {
    if (error.code === 'SOURCE_ITEM_UNAVAILABLE' || error.code === 'NO_SOURCE_ITEM') {
      return buildUnavailableText();
    }
    if (error.code === 'INVALID_SOURCE_COUNT') {
      return '仅支持 3 / 4 / 6 个券或奖品重铸';
    }
    if (error.code === 'INVALID_SOURCE_IDS') {
      return '所选券或奖品无效，请重新选择';
    }
  }

  if (error instanceof LotteryError) {
    if (error.code === 'NO_PRIZE_AVAILABLE' || error.code === 'NO_FALLBACK_PRIZE') {
      return '当前重铸奖池暂无可用奖品，请稍后再试';
    }
  }

  return '重铸失败，请稍后重试';
};

const resolveSessionFromInteraction = async (
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  sessionId: string,
) => {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) {
    await interaction.reply({ content: '这个重铸面板已过期，请重新使用 /重铸。', ephemeral: true });
    return null;
  }
  if (session.ownerDiscordUserId !== interaction.user.id) {
    await interaction.reply({ content: '这不是你的重铸面板。', ephemeral: true });
    return null;
  }
  touchSession(session);
  return session;
};

const refreshSessionInventory = async (session: LotteryFusionSession, keepSelection = true) => {
  const { items } = await getLotteryFusionSelectableInventoryForDiscordUser(session.ownerDiscordUserId);
  session.items = items;
  session.groups = buildLotteryFusionSelectableGroups(items);
  session.selectedSourceIds = keepSelection
    ? syncLotteryFusionSelection(session.selectedSourceIds, items)
    : [];
  session.targetCount = clampLotteryFusionTargetCount(session.targetCount, items.length);
  if (session.selectedSourceIds.length > session.targetCount) {
    session.selectedSourceIds = session.selectedSourceIds.slice(0, session.targetCount);
  }
  session.page = Math.min(session.page, getPageCount(session) - 1);
};

export const lotteryFusionCommand = new SlashCommandBuilder()
  .setName(CMD_NAME)
  .setDescription('打开重铸面板，并将未使用的券/奖品进行重铸')
  .addIntegerOption((option) =>
    option
      .setName('数量')
      .setDescription('先选择重铸规则：3 / 4 / 6 个融合')
      .setRequired(false)
      .addChoices(
        { name: '3 个融合', value: 3 },
        { name: '4 个融合', value: 4 },
        { name: '6 个融合', value: 6 },
      ),
  );

export async function handleLotteryFusionSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== CMD_NAME) return;

  pruneExpiredSessions();
  const { items } = await getLotteryFusionSelectableInventoryForDiscordUser(i.user.id);
  if (items.length < 3) {
    await i.reply({
      content: '你当前可重铸的券/奖品不足 3 个，暂时无法进行重铸。',
      ephemeral: false,
    });
    return;
  }

  const session = createSession({
    ownerDiscordUserId: i.user.id,
    items,
  });

  const requestedCount = i.options.getInteger('数量');
  if (requestedCount === 3 || requestedCount === 4 || requestedCount === 6) {
    if (items.length >= requestedCount) {
      session.targetCount = requestedCount;
      session.notice = `已按命令参数切换为 ${RULE_META[requestedCount].title}`;
    } else {
      session.notice = `当前可重铸券/奖品不足 ${requestedCount} 个，已为你保留可用规则。`;
    }
  }

  await i.reply({
    ...buildFusionPanelPayload(session),
    ephemeral: false,
  });
}

export async function handleLotteryFusionButton(i: ButtonInteraction) {
  const parts = parseCustomId(i.customId);
  if (!parts) return false;

  const [, action, subActionOrSessionId, maybeSessionId] = parts;
  const sessionId = maybeSessionId ?? subActionOrSessionId;
  const session = await resolveSessionFromInteraction(i, sessionId);
  if (!session) return true;

  if (action === 'count') {
    const count = Number(subActionOrSessionId) as FusionCount;
    if (![3, 4, 6].includes(count)) {
      await i.reply({ content: '无效的重铸规则。', ephemeral: true });
      return true;
    }
    if (session.items.length < count) {
      session.notice = `当前可重铸券/奖品不足 ${count} 个。`;
      await i.update(buildFusionPanelPayload(session));
      return true;
    }
    session.targetCount = count;
    session.selectedSourceIds = session.selectedSourceIds.slice(0, count);
    session.notice = `已切换为 ${RULE_META[count].title}`;
    await i.update(buildFusionPanelPayload(session));
    return true;
  }

  if (action === 'page') {
    session.page += subActionOrSessionId === 'next' ? 1 : -1;
    session.notice = null;
    await i.update(buildFusionPanelPayload(session));
    return true;
  }

  if (action === 'reset') {
    session.selectedSourceIds = [];
    session.notice = '已清空当前选择。';
    await i.update(buildFusionPanelPayload(session));
    return true;
  }

  if (action === 'refresh') {
    await i.deferUpdate();
    await refreshSessionInventory(session, true);
    session.notice = '列表已刷新。';
    await i.editReply(buildFusionPanelPayload(session));
    return true;
  }

  if (action === 'start') {
    if (session.selectedSourceIds.length !== session.targetCount) {
      session.notice = `请先选满 ${session.targetCount} 个券/奖品。`;
      await i.update(buildFusionPanelPayload(session));
      return true;
    }

    session.isSubmitting = true;
    session.notice = '正在执行重铸...';
    await i.update(buildFusionPanelPayload(session));

    try {
      const result = await performLotteryFusion({
        userId: i.user.id,
        sourceIds: session.selectedSourceIds,
        requestId: buildBotLotteryFusionRequestId(session.id),
      });
      sessions.delete(session.id);

      await i.editReply({
        content: buildLotteryFusionBotSuccessMessage(result.prize.name),
        embeds: [buildSuccessEmbed(result.prize.name, POOL_LABEL[result.pool], result.expiresAt ?? null)],
        components: [],
      });

      void sendLotteryFusionSuccessDm({
        client: i.client,
        discordUserId: i.user.id,
        prizeName: result.prize.name,
      });
    } catch (error) {
      console.error('[lottery-fusion] slash start failed', {
        userId: i.user.id,
        sessionId: session.id,
        error,
      });

      session.isSubmitting = false;
      if (error instanceof LotteryFusionError &&
          (error.code === 'SOURCE_ITEM_UNAVAILABLE' || error.code === 'NO_SOURCE_ITEM')) {
        await refreshSessionInventory(session, false);
      }
      session.notice = getFailureText(error);
      await i.editReply(buildFusionPanelPayload(session));
    }
    return true;
  }

  return false;
}

export async function handleLotteryFusionSelect(i: StringSelectMenuInteraction) {
  const parts = parseCustomId(i.customId);
  if (!parts) return false;

  const [, action, sessionId] = parts;
  const session = await resolveSessionFromInteraction(i, sessionId);
  if (!session) return true;

  if (action === 'add') {
    const selectedGroups = new Map(session.groups.map((group) => [group.key, group]));
    for (const groupKey of i.values) {
      if (session.selectedSourceIds.length >= session.targetCount) break;
      const group = selectedGroups.get(groupKey);
      if (!group) continue;
      const nextSourceId = takeNextSourceIdFromFusionGroup(group, session.selectedSourceIds);
      if (!nextSourceId) continue;
      session.selectedSourceIds.push(nextSourceId);
    }
    session.notice = `当前已选择 ${session.selectedSourceIds.length}/${session.targetCount}`;
    await i.update(buildFusionPanelPayload(session));
    return true;
  }

  if (action === 'remove') {
    const selectedGroups = new Map(session.groups.map((group) => [group.key, group]));
    for (const groupKey of i.values) {
      const group = selectedGroups.get(groupKey);
      if (!group) continue;
      const sourceId = takeLastSelectedSourceIdFromFusionGroup(group, session.selectedSourceIds);
      if (!sourceId) continue;
      const sourceIndex = session.selectedSourceIds.lastIndexOf(sourceId);
      if (sourceIndex >= 0) {
        session.selectedSourceIds.splice(sourceIndex, 1);
      }
    }
    session.notice = `当前已选择 ${session.selectedSourceIds.length}/${session.targetCount}`;
    await i.update(buildFusionPanelPayload(session));
    return true;
  }

  return false;
}
