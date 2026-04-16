import type { ParsedAssistantIntent, PlannerDecision, ResolvedAction, ResolutionResult } from './types.js';

const DISPATCH_GAME_LABELS: Record<string, string> = {
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

function buildDispatchConfirmationText(action: Extract<ResolvedAction, { kind: 'dispatch.create' }>) {
  const tokens: string[] = [];
  if (action.genderPreference === '小姐姐') {
    tokens.push('@女陪陪');
  } else if (action.genderPreference === '小哥哥') {
    tokens.push('@男陪陪');
  } else {
    tokens.push('@男陪陪', '@女陪陪');
  }
  if (action.companionType === '技术') tokens.push('@技术陪陪');

  const traits = [
    DISPATCH_GAME_LABELS[action.dispatchGame] ?? action.dispatchGame,
    action.dispatchRank,
    ...action.softPreferences,
  ].filter(Boolean);

  if (traits.length > 0) {
    tokens.push(traits.join(' '));
  }

  if (action.companionType && action.companionType !== '技术') {
    tokens.push(`${action.companionType}陪玩`);
  }

  if (action.orderContent) {
    tokens.push(`备注：${action.orderContent}`);
  }

  const summary = `确认发起派单：${tokens.join(' ')}`.trim();
  return `${summary}\n（还需补充要求可以直接发送消息给我）`;
}

function buildMissingSlotMessage(parsed: ParsedAssistantIntent) {
  if (parsed.intent === 'dispatch.create') {
    if (parsed.missingSlots.includes('dispatchGame')) {
      return '要派单的话，请告诉我是什么游戏，例如“瓦”“LoL”“OW”。';
    }
  }
  if (parsed.intent === 'order.create') {
    if (parsed.missingSlots.includes('workerReference')) {
      return '要点单的话，请告诉我是哪个陪玩，比如“给 1101 点单”或“点刚才那个陪玩”。';
    }
  }
  if (parsed.intent === 'gift.send') {
    if (parsed.missingSlots.includes('giftName') && parsed.missingSlots.includes('quantity')) {
      return '要打赏的话，请告诉我要送什么礼物、送几个。';
    }
    if (parsed.missingSlots.includes('giftName')) {
      return '要打赏的话，请告诉我要送什么礼物。';
    }
    if (parsed.missingSlots.includes('quantity')) {
      return '要打赏的话，请告诉我要送几个。';
    }
  }
  return '我理解到你在操作订单，但信息还不够，麻烦再具体一点。';
}

function confirmationText(action: ResolvedAction) {
  if (action.kind === 'dispatch.create') {
    return buildDispatchConfirmationText(action);
  }
  if (action.kind === 'order.create') {
    return `确认给 ${action.worker.sourceLabel} 发起点单吗？`;
  }
  if (action.kind === 'invite.accept') {
    const label = action.order.displayNo != null ? `#${action.order.displayNo}` : action.order.id;
    return `确认接受订单 ${label} 吗？`;
  }
  if (action.kind === 'invite.decline') {
    const label = action.order.displayNo != null ? `#${action.order.displayNo}` : action.order.id;
    return `确认拒绝订单 ${label} 吗？`;
  }
  if (action.kind === 'order.end') {
    const label = action.order.displayNo != null ? `#${action.order.displayNo}` : action.order.id;
    return `确认要结单 ${label} 吗？`;
  }
  if (action.kind === 'gift.send') {
    const qty = action.quantity;
    return `确认要给 ${action.worker.sourceLabel} 打赏 ${qty} 个 ${action.giftName} 吗？`;
  }
  return '确认执行吗？';
}

export function planBalanceQuery(parsed: ParsedAssistantIntent): PlannerDecision {
  if (parsed.confidence < 0.65) {
    return { kind: 'ignore' };
  }
  return { kind: 'execute', action: { kind: 'balance.query' } };
}

export function planDirectAssistantQuery(parsed: ParsedAssistantIntent): PlannerDecision {
  if (parsed.confidence < 0.65) {
    return { kind: 'ignore' };
  }

  if (parsed.intent === 'worker.id.query') {
    return { kind: 'execute', action: { kind: 'worker.id.query' } };
  }

  if (parsed.intent === 'help.query') {
    return { kind: 'execute', action: { kind: 'help.query', topic: parsed.helpTopic } };
  }

  return { kind: 'ignore' };
}

export function planAssistantAction(
  parsed: ParsedAssistantIntent,
  resolution: ResolutionResult<ResolvedAction>,
): PlannerDecision {
  if (parsed.confidence < 0.65) {
    return { kind: 'ignore' };
  }

  if (parsed.missingSlots.length > 0) {
    return { kind: 'reply', message: buildMissingSlotMessage(parsed) };
  }

  if (!resolution.ok) {
    return { kind: 'reply', message: resolution.error.message };
  }

  const action = resolution.value;
  return { kind: 'confirm', message: confirmationText(action), action };
}
