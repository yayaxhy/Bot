import type { Message } from 'discord.js';
import {
  buildAssistantConfirmationPayload,
  buildAssistantDisabledConfirmationPayload,
  registerAssistantConfirmationMessage,
} from './confirmButtons.js';
import { executeAssistantAction } from './executor.js';
import { logAssistantEvent } from './logger.js';
import {
  clearPendingConfirmation,
  clearPendingFollowUp,
  createPendingConfirmation,
  createPendingFollowUp,
  getConversationState,
  getPendingConfirmation,
  getPendingFollowUp,
  rememberResolvedAction,
} from './memory.js';
import { continueAssistantIntent, getAssistantInputContent, parseAssistantIntent } from './parser.js';
import { planAssistantAction, planBalanceQuery, planDirectAssistantQuery } from './planner.js';
import { resolveOrderReference, resolveWorkerReference } from './resolver.js';
import type { ParsedAssistantIntent, PlannerDecision, ResolvedAction, ResolutionResult } from './types.js';

function isDmMessage(message: Message) {
  return !message.guild;
}

function isMentionTriggerMessage(message: Message) {
  const botId = message.client.user?.id;
  if (!botId) return false;
  return message.mentions.users.has(botId);
}

async function sendAssistantReply(message: Message, content: string, options?: { preferDmForPublic?: boolean }) {
  if (options?.preferDmForPublic && message.guild) {
    try {
      const dmChannel = await message.author.createDM();
      await dmChannel.send(content);
      return;
    } catch {
      await message.reply('我没法私信你，请先开启私信后再试。');
      return;
    }
  }

  await message.reply(content);
}

function formatAssistantError(err: unknown) {
  const text = err instanceof Error ? err.message : String(err ?? '');
  if (text.includes('ORDER_NOT_ASSIGNED_TO_WORKER')) {
    return '这笔邀请不是发给你的。';
  }
  if (text.includes('ORDER_NOT_PENDING')) {
    return '这笔订单已经处理过了。';
  }
  if (text.includes('Order not running')) {
    return '这笔订单现在不是进行中，暂时不能结单。';
  }
  if (text.includes('余额不足')) {
    return text;
  }
  if (text.includes('礼物不存在')) {
    return text;
  }
  if (text.includes('不能给自己打赏')) {
    return text;
  }
  if (text.includes('陪玩繁忙')) {
    return '对方当前繁忙，暂时不能处理这笔邀请。';
  }
  return '处理失败了，请稍后再试。';
}

function parsedFromResolvedAction(action: ResolvedAction): ParsedAssistantIntent | null {
  if (action.kind === 'dispatch.create') {
    return {
      intent: 'dispatch.create',
      confidence: 0.9,
      source: 'rule',
      orderReference: null,
      workerReference: null,
      dispatchGame: action.dispatchGame,
      dispatchRank: action.dispatchRank,
      genderPreference: action.genderPreference,
      companionType: action.companionType,
      helpTopic: null,
      softPreferences: action.softPreferences,
      orderContent: action.orderContent,
      giftName: null,
      quantity: null,
      missingSlots: [],
      rationale: 'from pending confirmation',
    };
  }
  return null;
}

async function disableSupersededConfirmation(message: Message, pendingMessageId?: string) {
  if (!pendingMessageId) return;
  const channel = message.channel;
  if (!channel?.isTextBased?.()) return;
  try {
    const existing = await (channel as any).messages.fetch(pendingMessageId).catch(() => null);
    if (existing?.editable) {
      await existing.edit(buildAssistantDisabledConfirmationPayload('这条确认已被新的条件更新，请查看最新确认。'));
    }
  } catch (err) {
    console.error('[assistant] disable superseded confirmation failed:', err);
  }
}

async function resolveAction(
  message: Message,
  parsed: ParsedAssistantIntent,
): Promise<ResolutionResult<ResolvedAction>> {
  if (parsed.intent === 'balance.query') {
    return { ok: true, value: { kind: 'balance.query' } };
  }

  if (parsed.intent === 'dispatch.create') {
    if (!parsed.dispatchGame) {
      return { ok: false, error: { kind: 'missing', message: '要派单的话，请先告诉我是什么游戏。' } };
    }
    return {
      ok: true,
      value: {
        kind: 'dispatch.create',
        dispatchGame: parsed.dispatchGame,
        dispatchRank: parsed.dispatchRank,
        genderPreference: parsed.genderPreference,
        companionType: parsed.companionType,
        softPreferences: parsed.softPreferences,
        orderContent: parsed.orderContent,
      },
    };
  }

  if (parsed.intent === 'order.create') {
    const workerResult = await resolveWorkerReference({
      userId: message.author.id,
      reference: parsed.workerReference,
      conversation: getConversationState(message.author.id, message.channel.id),
    });
    if (!workerResult.ok) return workerResult;
    return {
      ok: true,
      value: {
        kind: 'order.create',
        worker: workerResult.value,
        orderContent: parsed.orderContent,
      },
    };
  }

  if (parsed.intent === 'invite.accept') {
    const orderResult = await resolveOrderReference({
      userId: message.author.id,
      reference: parsed.orderReference,
      fallbackKind: 'latest_pending_invitation',
      actionLabel: '接单',
    });
    if (!orderResult.ok) return orderResult;
    return { ok: true, value: { kind: 'invite.accept', order: orderResult.value } };
  }

  if (parsed.intent === 'invite.decline') {
    const orderResult = await resolveOrderReference({
      userId: message.author.id,
      reference: parsed.orderReference,
      fallbackKind: 'latest_pending_invitation',
      actionLabel: '拒单',
    });
    if (!orderResult.ok) return orderResult;
    return { ok: true, value: { kind: 'invite.decline', order: orderResult.value } };
  }

  if (parsed.intent === 'order.end') {
    const orderResult = await resolveOrderReference({
      userId: message.author.id,
      reference: parsed.orderReference,
      fallbackKind: 'latest_running_order',
      actionLabel: '结单',
    });
    if (!orderResult.ok) return orderResult;
    return { ok: true, value: { kind: 'order.end', order: orderResult.value } };
  }

  if (parsed.intent === 'gift.send') {
    const workerResult = await resolveWorkerReference({
      userId: message.author.id,
      reference: parsed.workerReference,
      conversation: getConversationState(message.author.id, message.channel.id),
    });
    if (!workerResult.ok) return workerResult;
    if (!parsed.giftName || !parsed.quantity) {
      return { ok: false, error: { kind: 'missing', message: '请告诉我要送什么礼物、送几个。' } };
    }
    return {
      ok: true,
      value: {
        kind: 'gift.send',
        worker: workerResult.value,
        giftName: parsed.giftName,
        quantity: parsed.quantity,
      },
    };
  }

  return { ok: false, error: { kind: 'not_found', message: '' } };
}

async function handlePlannerDecision(message: Message, parsed: ParsedAssistantIntent, decision: PlannerDecision) {
  if (decision.kind === 'ignore') return false;
  if (decision.kind === 'reply') {
    if (parsed.intent !== 'unknown' && parsed.missingSlots.length > 0) {
      createPendingFollowUp(message.author.id, message.channel.id, parsed, decision.message);
    } else {
      clearPendingFollowUp(message.author.id, message.channel.id);
    }
    logAssistantEvent('planner_reply', {
      message,
      decision,
    });
    await message.reply(decision.message);
    return true;
  }
  if (decision.kind === 'confirm') {
    clearPendingFollowUp(message.author.id, message.channel.id);
    createPendingConfirmation(message.author.id, message.channel.id, decision.action, decision.message);
    const promptMessage = await message.reply(buildAssistantConfirmationPayload(decision.message));
    await registerAssistantConfirmationMessage(message.author.id, message.channel.id, promptMessage);
    logAssistantEvent('planner_confirm', {
      message,
      decision,
    });
    return true;
  }

  try {
    clearPendingFollowUp(message.author.id, message.channel.id);
    const reply = await executeAssistantAction(message, decision.action);
    rememberResolvedAction(message.author.id, message.channel.id, decision.action);
    logAssistantEvent('planner_executed', {
      message,
      decision,
      action: decision.action,
      reply,
    });
    if (reply) {
      await sendAssistantReply(message, reply, {
        preferDmForPublic: decision.action.kind === 'balance.query',
      });
    }
  } catch (err) {
    logAssistantEvent('planner_execute_failed', {
      message,
      decision,
      action: decision.action,
      error: err,
    });
    await sendAssistantReply(message, formatAssistantError(err), {
      preferDmForPublic: decision.action.kind === 'balance.query',
    });
  }
  return true;
}

export async function tryHandleAssistantMessage(message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  const isDm = isDmMessage(message);
  const hasPendingConfirmation = !!getPendingConfirmation(message.author.id, message.channel.id);
  const hasPendingFollowUp = !!getPendingFollowUp(message.author.id, message.channel.id);
  const isMentionTrigger = !isDm && isMentionTriggerMessage(message);
  if (!isDm && !isMentionTrigger && !hasPendingConfirmation && !hasPendingFollowUp) return false;

  const assistantContent = getAssistantInputContent(message);
  if (!assistantContent) return false;
  if (assistantContent.startsWith('!')) return false;

  const pending = getPendingConfirmation(message.author.id, message.channel.id);
  if (pending) {
    const pendingParsed = parsedFromResolvedAction(pending.action);
    if (pendingParsed && pending.action.kind === 'dispatch.create') {
      const continued = continueAssistantIntent(pendingParsed, message);
      if (continued) {
        clearPendingConfirmation(message.author.id, message.channel.id);
        await disableSupersededConfirmation(message, pending.messageId);
        const resolution = await resolveAction(message, continued);
        if (!resolution.ok) {
          logAssistantEvent('resolution_failed', {
            message,
            parsed: continued,
            resolutionError: resolution.error,
            extra: { fromPendingConfirmation: true },
          });
        } else {
          logAssistantEvent('resolved', {
            message,
            parsed: continued,
            action: resolution.value,
            extra: { fromPendingConfirmation: true },
          });
        }
        return handlePlannerDecision(message, continued, planAssistantAction(continued, resolution));
      }
    }

    await message.reply('当前有待确认操作，请点击上面的“确认执行”或“取消操作”按钮。');
    return true;
  }

  const conversation = getConversationState(message.author.id, message.channel.id);
  const pendingFollowUp = getPendingFollowUp(message.author.id, message.channel.id);
  const parsed = pendingFollowUp
    ? (continueAssistantIntent(pendingFollowUp.parsed, message) ?? await parseAssistantIntent(message, { message, conversation }))
    : await parseAssistantIntent(message, { message, conversation });
  logAssistantEvent('parsed', {
    message,
    parsed,
    extra: {
      hasConversation: !!conversation,
      hasPendingFollowUp: !!pendingFollowUp,
      conversationLastIntent: conversation?.lastIntent ?? null,
      conversationLastOrderId: conversation?.lastOrderId ?? null,
      conversationLastWorkerId: conversation?.lastWorkerId ?? null,
    },
  });

  if (parsed.intent === 'unknown') {
    logAssistantEvent('ignored_unknown', {
      message,
      parsed,
    });
    return false;
  }

  if (parsed.intent === 'balance.query') {
    return handlePlannerDecision(message, parsed, planBalanceQuery(parsed));
  }

  if (parsed.intent === 'worker.id.query' || parsed.intent === 'help.query') {
    return handlePlannerDecision(message, parsed, planDirectAssistantQuery(parsed));
  }

  const resolution = await resolveAction(message, parsed);
  if (!resolution.ok) {
    logAssistantEvent('resolution_failed', {
      message,
      parsed,
      resolutionError: resolution.error,
    });
  } else {
    logAssistantEvent('resolved', {
      message,
      parsed,
      action: resolution.value,
    });
  }
  return handlePlannerDecision(message, parsed, planAssistantAction(parsed, resolution));
}
