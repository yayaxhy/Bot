import type { Message } from 'discord.js';
import {
  type AssistantContext,
  type AssistantIntent,
  type ParsedAssistantIntent,
} from './types.js';
import { parseWithConfiguredProvider } from './providers/index.js';

const CONFIRM_PATTERN = /^(确认|确定|好|好的|是|是的|确认执行)$/;
const CANCEL_PATTERN = /^(取消|算了|不用了|停止)$/;

const GAME_PATTERNS: Array<{ value: string; patterns: RegExp[] }> = [
  { value: 'VAL', patterns: [/\bval(?:orant)?\b/i, /瓦(?:罗兰特)?/] },
  { value: 'LOL', patterns: [/\blol\b/i, /英雄联盟|联盟/] },
  { value: 'OW', patterns: [/\bow\b/i, /守望|ow2/i] },
  { value: 'APEX', patterns: [/\bapex\b/i] },
  { value: 'CSGO', patterns: [/\bcs2?\b/i, /csgo/i, /反恐|cs/] },
  { value: 'NARAKA', patterns: [/永劫|naraka/i] },
  { value: 'DELTA', patterns: [/三角洲|delta/i] },
  { value: 'TFT', patterns: [/云顶|tft/i] },
  { value: 'STEAM', patterns: [/steam/i] },
];

const RANK_PATTERNS: Array<{ value: string; patterns: RegExp[] }> = [
  { value: '黑铁', patterns: [/黑铁/] },
  { value: '青铜', patterns: [/青铜/] },
  { value: '白银', patterns: [/白银/] },
  { value: '黄金', patterns: [/黄金/] },
  { value: '铂金', patterns: [/铂金/] },
  { value: '钻石', patterns: [/钻石/] },
  { value: '超凡', patterns: [/超凡|ascendant/i] },
  { value: '神话', patterns: [/神话|immortal/i] },
  { value: '王者', patterns: [/王者|radiant/i] },
];

const SOFT_PREFERENCE_PATTERNS = [
  '活泼',
  '话多',
  '温柔',
  '会聊天',
  '能聊',
  '声音好听',
  '耐心',
  '便宜点',
  '技术好',
];

function createBaseResult(source: 'ai' | 'rule', rationale: string): ParsedAssistantIntent {
  return {
    intent: 'unknown',
    confidence: 0.1,
    source,
    orderReference: null,
    workerReference: null,
    dispatchGame: null,
    dispatchRank: null,
    genderPreference: null,
    companionType: null,
    helpTopic: null,
    softPreferences: [],
    orderContent: null,
    giftName: null,
    quantity: null,
    missingSlots: [],
    rationale,
  };
}

export function getAssistantInputContent(message: Message): string {
  const raw = message.content ?? '';
  const botId = message.client.user?.id;
  if (!botId) return raw.trim();
  return raw
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildUnknownResult(source: 'ai' | 'rule', rationale: string): ParsedAssistantIntent {
  return createBaseResult(source, rationale);
}

function firstMatchedValue(
  content: string,
  candidates: Array<{ value: string; patterns: RegExp[] }>,
): string | null {
  for (const candidate of candidates) {
    if (candidate.patterns.some((pattern) => pattern.test(content))) {
      return candidate.value;
    }
  }
  return null;
}

function extractSoftPreferences(content: string) {
  return SOFT_PREFERENCE_PATTERNS.filter((item) => content.includes(item));
}

function extractGenderPreference(content: string) {
  if (/小姐姐|女生|妹妹/.test(content)) return '小姐姐';
  if (/小哥哥|男生|弟弟/.test(content)) return '小哥哥';
  return null;
}

function extractCompanionType(content: string) {
  if (/技术/.test(content)) return '技术';
  if (/大神/.test(content)) return '大神';
  if (/娱乐/.test(content)) return '娱乐';
  return null;
}

function sanitizeOrderContent(content: string) {
  let sanitized = content
    .replace(/[，。！？!?,]/g, ' ')
    .replace(/(?:给我|帮我|想要|要|来个|来一个|安排|整一个)/g, ' ')
    .replace(/(?:派一个单|派个单|派单|点单|打赏|送礼|结单|接单|拒单|查下我余额|查余额)/g, ' ')
    .replace(/(?:刚才那个陪玩|当前陪玩|这个陪玩|她|他|上一单|刚才那单)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const candidate of GAME_PATTERNS) {
    for (const pattern of candidate.patterns) {
      sanitized = sanitized.replace(pattern, ' ');
    }
  }
  for (const candidate of RANK_PATTERNS) {
    for (const pattern of candidate.patterns) {
      sanitized = sanitized.replace(pattern, ' ');
    }
  }
  sanitized = sanitized
    .replace(/小姐姐|小哥哥|女生|男生|妹妹|弟弟/g, ' ')
    .replace(/技术|大神|娱乐/g, ' ');
  for (const item of SOFT_PREFERENCE_PATTERNS) {
    sanitized = sanitized.replace(new RegExp(item, 'g'), ' ');
  }
  return sanitized.replace(/\s+/g, ' ').trim();
}

function extractExplicitOrderReference(content: string): ParsedAssistantIntent['orderReference'] {
  const explicitDisplay = content.match(/(?:订单号|单号|#)\s*[:：]?\s*([A-Za-z_-]*)(\d{1,10})/i);
  if (explicitDisplay) {
    return {
      kind: 'explicit_display_no',
      raw: explicitDisplay[2],
    };
  }

  const explicitId = content.match(/订单(?:id)?\s*[:：]?\s*([a-z0-9]{20,})/i);
  if (explicitId) {
    return {
      kind: 'explicit_id',
      raw: explicitId[1],
    };
  }

  if (/上一单|上个订单/.test(content)) return { kind: 'previous_order' };
  if (/刚才那单|当前那单|这单|这个订单/.test(content)) return { kind: 'latest_running_order' };
  if (/邀请|接单|拒单/.test(content)) return { kind: 'latest_pending_invitation' };
  if (/订单|结单|结束/.test(content)) return { kind: 'latest_order' };
  return null;
}

function extractExplicitWorkerReference(message: Message): ParsedAssistantIntent['workerReference'] {
  const content = getAssistantInputContent(message);
  const botId = message.client.user?.id;
  const mentionedUser = Array.from(message.mentions.users.values()).find((user) => user.id !== botId);
  if (mentionedUser) {
    return {
      kind: 'explicit_discord_user_id',
      raw: mentionedUser.id,
    };
  }

  const explicitMention = content.match(/<@!?(\d+)>/);
  if (explicitMention) {
    return {
      kind: 'explicit_discord_user_id',
      raw: explicitMention[1],
    };
  }

  const explicitAtPeiwanId = content.match(/(?:^|[\s(（])@(\d{3,10})(?=$|[\s)）])/);
  if (explicitAtPeiwanId && /打赏|送礼|点单/.test(content)) {
    return {
      kind: 'explicit_peiwan_id',
      raw: explicitAtPeiwanId[1],
    };
  }

  const explicitPeiwanId = content.match(/(?:陪玩(?:编号|id)?|给|点)\s*[:：]?\s*(\d{3,10})/i);
  if (explicitPeiwanId && /打赏|送礼|点单/.test(content)) {
    return {
      kind: 'explicit_peiwan_id',
      raw: explicitPeiwanId[1],
    };
  }

  if (/昨天那个陪玩|昨天那个小姐姐|昨天那个小哥哥/.test(content)) return { kind: 'yesterday_worker' };
  if (/她|他|当前陪玩|这个陪玩|刚才那个陪玩/.test(content)) return { kind: 'current_order_worker' };
  if (/上一个陪玩|上一位陪玩/.test(content)) return { kind: 'last_worker' };
  return null;
}

function parseGiftIntent(content: string): ParsedAssistantIntent | null {
  if (!/打赏|送礼/.test(content)) return null;

  const result = createBaseResult('rule', 'matched gift keywords');
  result.intent = 'gift.send';
  return populateGiftIntent(result, content);
}

function populateGiftIntent(result: ParsedAssistantIntent, content: string): ParsedAssistantIntent {
  const slashMatch =
    content.match(/(?:打赏|送礼)[^0-9]*(\d+)\s*\/\s*([^\s，。,！!？?]+)/)
    ?? content.match(/(\d+)\s*\/\s*([^\s，。,！!？?]+)/);

  const quantityMatch = content.match(/(\d+)\s*个?/);
  result.quantity = slashMatch ? Number(slashMatch[1]) : quantityMatch ? Number(quantityMatch[1]) : null;

  const giftMatch =
    slashMatch
      ? [slashMatch[0], slashMatch[1], slashMatch[2]]
      : content.match(/(?:打赏|送礼)(?:给|给到|给)?(?:她|他|当前陪玩|这个陪玩|刚才那个陪玩|\d+)?\s*(\d+)\s*个?\s*([^\s，。,！!？?]+)/)
    ?? content.match(/(\d+)\s*个?\s*([^\s，。,！!？?]+)(?:给|送给)?(?:她|他|当前陪玩|这个陪玩|刚才那个陪玩|\d+)?/);
  result.giftName = giftMatch?.[2]?.trim().replace(/^\/+/, '') ?? null;

  if (!result.giftName) result.missingSlots.push('giftName');
  if (!result.quantity) result.missingSlots.push('quantity');
  result.confidence = result.giftName && result.quantity ? 0.88 : 0.7;
  return result;
}

function parseDispatchIntent(content: string): ParsedAssistantIntent | null {
  if (!/派单|派个单|派一个单|发个单|发一个单/.test(content)) return null;

  const result = createBaseResult('rule', 'matched dispatch keywords');
  result.intent = 'dispatch.create';
  result.dispatchGame = firstMatchedValue(content, GAME_PATTERNS);
  result.dispatchRank = firstMatchedValue(content, RANK_PATTERNS);
  result.genderPreference = extractGenderPreference(content);
  result.companionType = extractCompanionType(content);
  result.softPreferences = extractSoftPreferences(content);
  const orderContent = sanitizeOrderContent(content);
  result.orderContent = orderContent || null;
  if (!result.dispatchGame) result.missingSlots.push('dispatchGame');
  result.confidence = result.dispatchGame ? 0.86 : 0.68;
  return result;
}

function detectHelpTopic(content: string) {
  if (/陪玩id|陪玩编号|我的编号/.test(content)) return 'worker.id.query';
  if (/点单/.test(content)) return 'order.create';
  if (/打赏|送礼/.test(content)) return 'gift.send';
  if (/派单|发单/.test(content)) return 'dispatch.create';
  if (/余额/.test(content)) return 'balance.query';
  if (/结单|结束订单/.test(content)) return 'order.end';
  if (/接单/.test(content)) return 'invite.accept';
  if (/拒单|不接/.test(content)) return 'invite.decline';
  return 'general';
}

function parseHelpIntent(content: string): ParsedAssistantIntent | null {
  if (!/(怎么|如何|咋|能做什么|可以做什么|帮助|帮助手册|怎么用|玩法|说明|你好|您好|在吗|hello|hi)/i.test(content)) {
    return null;
  }

  const result = createBaseResult('rule', 'matched help keywords');
  result.intent = 'help.query';
  result.helpTopic = detectHelpTopic(content);
  result.confidence = 0.96;
  return result;
}

function parseWorkerIdQueryIntent(content: string): ParsedAssistantIntent | null {
  if (!/(我的|我)陪玩(?:id|ID|编号).*(多少|是什么|是啥|查询|查下)?|查下我的陪玩(?:id|ID|编号)|我是不是陪玩/.test(content)) {
    return null;
  }

  const result = createBaseResult('rule', 'matched worker-id query keywords');
  result.intent = 'worker.id.query';
  result.confidence = 0.99;
  return result;
}

function parseOrderCreateIntent(message: Message): ParsedAssistantIntent | null {
  const content = getAssistantInputContent(message);
  if (!/点单|点刚才那个|点这个陪玩|给.*点单/.test(content)) return null;

  const result = createBaseResult('rule', 'matched order-create keywords');
  result.intent = 'order.create';
  result.workerReference = extractExplicitWorkerReference(message);
  result.orderContent = sanitizeOrderContent(content) || null;
  if (!result.workerReference) result.missingSlots.push('workerReference');
  result.confidence = result.workerReference ? 0.84 : 0.65;
  return result;
}

function parseRuleBasedIntent(message: Message): ParsedAssistantIntent {
  const content = getAssistantInputContent(message);
  if (!content) return buildUnknownResult('rule', 'empty message');

  if (CONFIRM_PATTERN.test(content) || CANCEL_PATTERN.test(content)) {
    return buildUnknownResult('rule', 'confirmation handled elsewhere');
  }

  const workerIdQueryIntent = parseWorkerIdQueryIntent(content);
  if (workerIdQueryIntent) return workerIdQueryIntent;

  const helpIntent = parseHelpIntent(content);
  if (helpIntent) return helpIntent;

  const giftIntent = parseGiftIntent(content);
  if (giftIntent) {
    giftIntent.workerReference = extractExplicitWorkerReference(message) ?? { kind: 'current_order_worker' };
    return giftIntent;
  }

  const dispatchIntent = parseDispatchIntent(content);
  if (dispatchIntent) return dispatchIntent;

  const orderCreateIntent = parseOrderCreateIntent(message);
  if (orderCreateIntent) return orderCreateIntent;

  if (/查.*余额|余额.*(多少|还有|查询)|我余额|余额查询/.test(content)) {
    const result = createBaseResult('rule', 'matched balance keywords');
    result.intent = 'balance.query';
    result.confidence = 0.99;
    return result;
  }

  if (/^(接单|我接|接受|接这单|接这个|同意)$/i.test(content)) {
    const result = createBaseResult('rule', 'matched invite accept keywords');
    result.intent = 'invite.accept';
    result.confidence = 0.99;
    result.orderReference = { kind: 'latest_pending_invitation' };
    return result;
  }

  if (/^(拒单|拒绝|不接|这单不接|我不接|拒绝这单)$/i.test(content)) {
    const result = createBaseResult('rule', 'matched invite decline keywords');
    result.intent = 'invite.decline';
    result.confidence = 0.99;
    result.orderReference = { kind: 'latest_pending_invitation' };
    return result;
  }

  if (/结单|结束订单|结束这单|帮我结一下/.test(content)) {
    const result = createBaseResult('rule', 'matched end-order keywords');
    result.intent = 'order.end';
    result.confidence = 0.9;
    result.orderReference = extractExplicitOrderReference(content) ?? { kind: 'latest_running_order' };
    return result;
  }

  return buildUnknownResult('rule', 'no rule matched');
}

function mergeParsedIntent(base: ParsedAssistantIntent, incoming: ParsedAssistantIntent): ParsedAssistantIntent {
  const merged: ParsedAssistantIntent = {
    ...base,
    ...incoming,
    intent: base.intent,
    source: 'rule',
    confidence: Math.max(base.confidence, incoming.confidence, 0.72),
    orderReference: incoming.orderReference ?? base.orderReference,
    workerReference: incoming.workerReference ?? base.workerReference,
    dispatchGame: incoming.dispatchGame ?? base.dispatchGame,
    dispatchRank: incoming.dispatchRank ?? base.dispatchRank,
    genderPreference: incoming.genderPreference ?? base.genderPreference,
    companionType: incoming.companionType ?? base.companionType,
    softPreferences: Array.from(new Set([...(base.softPreferences ?? []), ...(incoming.softPreferences ?? [])])),
    orderContent: incoming.orderContent || base.orderContent,
    giftName: incoming.giftName ?? base.giftName,
    quantity: incoming.quantity ?? base.quantity,
    missingSlots: [],
    rationale: `follow-up:${base.intent}`,
  };

  if (merged.intent === 'dispatch.create' && !merged.dispatchGame) {
    merged.missingSlots.push('dispatchGame');
  }
  if (merged.intent === 'order.create' && !merged.workerReference) {
    merged.missingSlots.push('workerReference');
  }
  if (merged.intent === 'gift.send') {
    if (!merged.giftName) merged.missingSlots.push('giftName');
    if (!merged.quantity) merged.missingSlots.push('quantity');
  }
  return merged;
}

export function continueAssistantIntent(
  base: ParsedAssistantIntent,
  message: Message,
): ParsedAssistantIntent | null {
  const content = getAssistantInputContent(message);
  if (!content) return null;

  if (base.intent === 'dispatch.create') {
    const incoming = createBaseResult('rule', 'dispatch follow-up');
    incoming.intent = 'dispatch.create';
    incoming.dispatchGame = firstMatchedValue(content, GAME_PATTERNS);
    incoming.dispatchRank = firstMatchedValue(content, RANK_PATTERNS);
    incoming.genderPreference = extractGenderPreference(content);
    incoming.companionType = extractCompanionType(content);
    incoming.softPreferences = extractSoftPreferences(content);
    incoming.orderContent = sanitizeOrderContent(content) || null;
    return mergeParsedIntent(base, incoming);
  }

  if (base.intent === 'order.create') {
    const incoming = createBaseResult('rule', 'order-create follow-up');
    incoming.intent = 'order.create';
    incoming.workerReference = extractExplicitWorkerReference(message);
    incoming.orderContent = sanitizeOrderContent(content) || null;
    return mergeParsedIntent(base, incoming);
  }

  if (base.intent === 'gift.send') {
    const incoming = parseGiftIntent(content) ?? createBaseResult('rule', 'gift follow-up');
    incoming.intent = 'gift.send';
    incoming.workerReference = extractExplicitWorkerReference(message) ?? incoming.workerReference;
    if (!incoming.workerReference) {
      incoming.workerReference = base.workerReference;
    }
    return mergeParsedIntent(base, incoming);
  }

  return null;
}

function normalizeIntent(value: unknown): AssistantIntent {
  switch (value) {
    case 'dispatch.create':
    case 'order.create':
    case 'invite.accept':
    case 'invite.decline':
    case 'order.end':
    case 'gift.send':
    case 'balance.query':
    case 'worker.id.query':
    case 'help.query':
      return value;
    default:
      return 'unknown';
  }
}

export async function parseAssistantIntent(
  message: Message,
  context: AssistantContext,
): Promise<ParsedAssistantIntent> {
  const ruleResult = parseRuleBasedIntent(message);
  if (ruleResult.intent !== 'unknown') {
    return ruleResult;
  }

  try {
    const aiResult = await parseWithConfiguredProvider(getAssistantInputContent(message), context);
    if (aiResult) {
      aiResult.intent = normalizeIntent(aiResult.intent);
      if (aiResult.intent !== 'unknown') {
        return aiResult;
      }
    }
  } catch (err) {
    console.error('[assistant.parser] AI parse failed:', err);
  }

  return ruleResult;
}

export function isConfirmationMessage(content: string) {
  return CONFIRM_PATTERN.test(content.trim());
}

export function isCancellationMessage(content: string) {
  return CANCEL_PATTERN.test(content.trim());
}
