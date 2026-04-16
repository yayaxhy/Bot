import {
  ActionRowBuilder,
  ButtonInteraction,
  EmbedBuilder,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  userMention,
  type Client,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { QuotationCode } from '@prisma/client';
import prisma from '../db/prisma.js';
import {
  anonymous_ongoing_order_request_embed,
  buildQuotationSelect,
  order_request_sent_successfully_embed,
  parseRoleMentions,
} from '../ui/orderEmbeds.js';
import { clickStore } from '../services/clickStore.js';
import { scheduleOrderRequestClosure } from '../services/orderInteractionManager.js';
import { recordOrderRequest } from '../services/orderRequestLogService.js';
import { updateMemberServerDisplayName } from '../services/memberDisplayNameService.js';
import { getActiveActivities } from '../services/activityService.js';
import { getDispatchImageUrlForOwner } from '../services/orderDispatchImageService.js';

type AssistantOrderContext = Message | ButtonInteraction;

function actorUser(target: AssistantOrderContext) {
  return 'author' in target ? target.author : target.user;
}

async function sendAssistantPayload(
  context: AssistantOrderContext,
  payload: string | MessageCreateOptions | InteractionReplyOptions,
) {
  if ('author' in context) {
    await context.reply(payload as string | MessageCreateOptions);
    return;
  }

  const channel = context.channel;
  if (channel && channel.isTextBased() && hasSend(channel)) {
    await channel.send(payload as string | MessageCreateOptions);
    return;
  }

  await context.followUp(payload as string | InteractionReplyOptions);
}

const ORDER_ANON_CHANNEL_ID = process.env.ORDER_ANON_CHANNEL_ID;
const ANON_NOTIFY_CHANNEL_ID = process.env.ANON_NOTIFY_CHANNEL_ID ?? '1440888773172006962';
const DEFAULT_EMBED_COLOR = 0xf5a623;
const GAME_LABELS: Record<string, string> = {
  VAL: '瓦',
  LOL: 'LoL',
  OW: 'OW',
  APEX: 'Apex',
  CSGO: 'CSGO',
  NARAKA: '永劫',
  DELTA: '三角洲',
  TFT: 'TFT',
  STEAM: 'Steam',
};
const PRICE_FIELD_BY_CODE: Record<QuotationCode, string> = {
  Q1: 'quotation_Q1',
  Q2: 'lolPrice',
  Q3: 'valPrice',
  Q4: 'deltaPrice',
  Q5: 'csgoPrice',
  Q6: 'narakaPrice',
  Q7: 'apexPrice',
  Q8: 'owPrice',
  Q9: 'tftPrice',
  Q10: 'steamPrice',
};

function hasSend(channel: unknown): channel is TextBasedChannel & { send: Function } {
  return !!channel && typeof (channel as any).send === 'function';
}

const isMissingAccessError = (err: any) =>
  err?.code === 50001 || (typeof err?.message === 'string' && err.message.includes('Missing Access'));

async function safeFetchChannel(client: Client, channelId: string, context: string) {
  try {
    return await client.channels.fetch(channelId);
  } catch (err) {
    if (isMissingAccessError(err)) return null;
    console.error(`[assistant.orderActions] ${context} fetch failed:`, err);
    return null;
  }
}

async function safeSend(action: () => Promise<unknown>, context: string) {
  try {
    await action();
  } catch (err) {
    if (isMissingAccessError(err)) return;
    console.error(`[assistant.orderActions] ${context} send failed:`, err);
  }
}

function normalizeOrderText(text: string) {
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
}

function buildDispatchRequestText(params: {
  dispatchGame: string;
  dispatchRank: string | null;
  genderPreference: string | null;
  companionType: string | null;
  softPreferences: string[];
  orderContent: string | null;
}) {
  const roleTokens: string[] = [];
  if (params.genderPreference === '小姐姐') {
    roleTokens.push('@女陪陪');
  } else if (params.genderPreference === '小哥哥') {
    roleTokens.push('@男陪陪');
  } else {
    roleTokens.push('@男陪陪', '@女陪陪');
  }
  if (params.companionType === '技术') roleTokens.push('@技术陪陪');

  const lines: string[] = [];
  if (roleTokens.length > 0) lines.push(roleTokens.join(' '));

  const traits = [
    GAME_LABELS[params.dispatchGame] ?? params.dispatchGame,
    params.dispatchRank,
    params.genderPreference,
    params.companionType ? `${params.companionType}陪玩` : null,
  ].filter(Boolean);
  if (traits.length) lines.push(traits.join(' '));

  if (params.softPreferences.length > 0) {
    lines.push(`偏好：${params.softPreferences.join('、')}`);
  }
  if (params.orderContent) {
    lines.push(`备注：${params.orderContent}`);
  }

  return normalizeOrderText(lines.join('\n'));
}

function priceFromPeiwan(peiwan: any, code: QuotationCode): number | null {
  const key = PRICE_FIELD_BY_CODE[code] as keyof typeof peiwan;
  const raw = peiwan?.[key];
  if (raw == null) return null;
  const num = typeof raw === 'number' ? raw : Number(raw?.toString?.());
  return Number.isFinite(num) ? (num as number) : null;
}

async function getMemberBalance(discordUserId: string): Promise<number | null> {
  const member = await prisma.member.findUnique({
    where: { discordUserId },
    select: { totalBalance: true },
  });
  if (!member?.totalBalance) return null;
  const numeric = Number(member.totalBalance.toString());
  return Number.isFinite(numeric) ? numeric : null;
}

async function sendAnonLogMessage(client: Client, content: string) {
  if (!ANON_NOTIFY_CHANNEL_ID) return;
  const channel = await safeFetchChannel(client, ANON_NOTIFY_CHANNEL_ID, 'anon log channel');
  if (channel && channel.isTextBased() && hasSend(channel)) {
    await safeSend(
      () => channel.send({ content, allowedMentions: { parse: ['users'] } }),
      'anon log',
    );
  }
}

export async function executeNaturalDispatchCreate(
  context: AssistantOrderContext,
  params: {
    dispatchGame: string;
    dispatchRank: string | null;
    genderPreference: string | null;
    companionType: string | null;
    softPreferences: string[];
    orderContent: string | null;
  },
) {
  if (!ORDER_ANON_CHANNEL_ID) {
    throw new Error('未配置匿名派单频道。');
  }

  const requestContent = buildDispatchRequestText(params);
  const orderId = context.id;
  const user = actorUser(context);
  const ownerId = user.id;
  clickStore.init(orderId, ownerId);

  const activities = await getActiveActivities();
  const dispatchImageUrl = await getDispatchImageUrlForOwner(ownerId);
  const channel = await safeFetchChannel(context.client, ORDER_ANON_CHANNEL_ID, 'anon order channel');
  if (!channel || !channel.isTextBased() || !hasSend(channel)) {
    throw new Error('匿名派单频道不可用。');
  }

  const ownerDisplayName =
    context.member && typeof context.member === 'object' && 'displayName' in context.member
      ? (context.member.displayName as string | null)
      : null;
  updateMemberServerDisplayName(prisma, ownerId, ownerDisplayName).catch(() => {});
  recordOrderRequest({
    orderId,
    ownerId,
    content: requestContent,
    ownerDisplayName,
  }).catch(() => {});

  const roleInfo = parseRoleMentions(requestContent);
  if (roleInfo.mentionText) {
    await channel.send({
      content: roleInfo.mentionText,
      allowedMentions: { users: [], roles: roleInfo.roleIds, parse: [] },
    });
  }

  const anonHint = await channel.send('老板派单啦，快来抢单');
  clickStore.registerMessage(orderId, anonHint.id, anonHint.channelId, ownerId, 'hint');
  const embedResponse = anonymous_ongoing_order_request_embed(
    requestContent,
    requestContent,
    orderId,
    ownerId,
    undefined,
    activities,
    dispatchImageUrl,
  );
  const posted = await channel.send(embedResponse);
  clickStore.registerMessage(orderId, posted.id, posted.channelId, ownerId, 'body');
  scheduleOrderRequestClosure(posted);

  const { embed, components } = order_request_sent_successfully_embed(orderId, ownerId, activities);
  await sendAssistantPayload(context, { content: '已按你的要求发起派单。', embeds: [embed], components });

  const balance = await getMemberBalance(ownerId);
  const balanceLabel = typeof balance === 'number' && Number.isFinite(balance) ? balance.toFixed(2) : '未知';
  await sendAnonLogMessage(
    context.client,
    [
      '【匿名派单】',
      `派单人：${userMention(ownerId)} (${ownerId})`,
      `派单内容：${requestContent || '（无）'}`,
      `派单人余额：${balanceLabel}`,
    ].join('\n'),
  );
}

export async function executeNaturalOrderCreate(
  context: AssistantOrderContext,
  params: {
    workerId: string;
    peiwanId: number | null;
    orderContent: string | null;
  },
) {
  const user = actorUser(context);
  let peiwanId = params.peiwanId;
  if (peiwanId == null) {
    const peiwanByWorker = await prisma.pEIWAN.findUnique({
      where: { discordUserId: params.workerId },
      select: { PEIWANID: true },
    });
    peiwanId = peiwanByWorker?.PEIWANID ?? null;
  }

  if (peiwanId == null) {
    throw new Error('没找到这位陪玩的编号，暂时不能直接点单。');
  }

  if (params.workerId === user.id) {
    throw new Error('不能点单自己哦。');
  }

  const hostMember = await prisma.member.upsert({
    where: { discordUserId: user.id },
    create: { discordUserId: user.id },
    update: {},
    select: { totalBalance: true },
  });
  const hostBalance = Number(hostMember.totalBalance.toString());
  if (!Number.isFinite(hostBalance) || hostBalance < 100) {
    throw new Error('余额不足 100，点单失败。请先充值后再试。');
  }

  const peiwan = await prisma.pEIWAN.findUnique({
    where: { PEIWANID: peiwanId },
    select: {
      PEIWANID: true,
      discordUserId: true,
      quotation_Q1: true,
      lolPrice: true,
      valPrice: true,
      deltaPrice: true,
      csgoPrice: true,
      narakaPrice: true,
      apexPrice: true,
      owPrice: true,
      tftPrice: true,
      steamPrice: true,
    },
  });
  if (!peiwan) {
    throw new Error(`未找到编号为 ${peiwanId} 的陪玩。`);
  }

  const prices: Partial<Record<QuotationCode, number | null>> = {};
  for (const code of Object.keys(PRICE_FIELD_BY_CODE) as Array<QuotationCode>) {
    prices[code] = priceFromPeiwan(peiwan, code);
  }

  const priceSelect = buildQuotationSelect('ANON', prices, context.id);
  if (!priceSelect) {
    throw new Error('该陪玩暂未配置可用价格，请联系工作人员。');
  }

  const embed = new EmbedBuilder()
    .setTitle('请选择价格档位')
    .setColor(DEFAULT_EMBED_COLOR)
    .setDescription('选择价格后，机器人会向陪玩发送邀请。')
    .addFields({
      name: '陪玩ID',
      value: `${peiwan.PEIWANID}${peiwan.discordUserId ? ` ${userMention(peiwan.discordUserId)}` : ''}`.trim(),
      inline: true,
    })
    .addFields({
      name: '点单模式',
      value: '匿名点单',
      inline: true,
    });

  if (params.orderContent) {
    embed.addFields({ name: '订单内容', value: params.orderContent.slice(0, 1024), inline: false });
  }

  const row = new ActionRowBuilder<any>().addComponents(priceSelect);
  await sendAssistantPayload(context, {
    content: '已识别到你要点单，请选择价格后继续：',
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  });
}
