import type { Message } from 'discord.js';
import type {
  ParsedAssistantIntent,
  PlannerDecision,
  ResolvedAction,
  ResolutionFailure,
  ResolvedOrderTarget,
  ResolvedWorkerTarget,
} from './types.js';

function truncate(text: string | null | undefined, max = 160) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function baseMessagePayload(message: Message) {
  return {
    messageId: message.id,
    userId: message.author.id,
    channelId: message.channel.id,
    guildId: message.guild?.id ?? null,
    content: truncate(message.content?.trim() ?? ''),
  };
}

function summarizeOrder(order: ResolvedOrderTarget) {
  return {
    id: order.id,
    displayNo: order.displayNo,
    status: order.status,
    hostId: order.hostId,
    workerId: order.workerId,
    peiwanId: order.peiwanId,
  };
}

function summarizeWorker(worker: ResolvedWorkerTarget) {
  return {
    workerId: worker.workerId,
    peiwanId: worker.peiwanId,
    sourceLabel: worker.sourceLabel,
  };
}

export function summarizeAction(action: ResolvedAction) {
  switch (action.kind) {
    case 'dispatch.create':
      return {
        kind: action.kind,
        dispatchGame: action.dispatchGame,
        dispatchRank: action.dispatchRank,
        genderPreference: action.genderPreference,
        companionType: action.companionType,
        softPreferences: action.softPreferences,
        orderContent: truncate(action.orderContent),
      };
    case 'order.create':
      return {
        kind: action.kind,
        worker: summarizeWorker(action.worker),
        orderContent: truncate(action.orderContent),
      };
    case 'invite.accept':
    case 'invite.decline':
    case 'order.end':
      return {
        kind: action.kind,
        order: summarizeOrder(action.order),
      };
    case 'gift.send':
      return {
        kind: action.kind,
        worker: summarizeWorker(action.worker),
        giftName: action.giftName,
        quantity: action.quantity,
      };
    case 'balance.query':
    case 'worker.id.query':
      return { kind: action.kind };
    case 'help.query':
      return { kind: action.kind, topic: action.topic };
    default:
      return { kind: 'unknown' };
  }
}

export function summarizeParsedIntent(parsed: ParsedAssistantIntent) {
  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    source: parsed.source,
    orderReference: parsed.orderReference,
    workerReference: parsed.workerReference,
    dispatchGame: parsed.dispatchGame,
    dispatchRank: parsed.dispatchRank,
    genderPreference: parsed.genderPreference,
    companionType: parsed.companionType,
    helpTopic: parsed.helpTopic,
    softPreferences: parsed.softPreferences,
    orderContent: truncate(parsed.orderContent),
    giftName: parsed.giftName,
    quantity: parsed.quantity,
    missingSlots: parsed.missingSlots,
    rationale: truncate(parsed.rationale),
  };
}

export function summarizePlannerDecision(decision: PlannerDecision) {
  switch (decision.kind) {
    case 'ignore':
      return { kind: 'ignore' };
    case 'reply':
      return { kind: 'reply', message: truncate(decision.message) };
    case 'confirm':
      return {
        kind: 'confirm',
        message: truncate(decision.message),
        action: summarizeAction(decision.action),
      };
    case 'execute':
      return {
        kind: 'execute',
        action: summarizeAction(decision.action),
      };
    default:
      return { kind: 'unknown' };
  }
}

export function summarizeResolutionFailure(error: ResolutionFailure) {
  return {
    kind: error.kind,
    message: truncate(error.message),
  };
}

export function logAssistantEvent(
  event: string,
  params: {
    message?: Message;
    parsed?: ParsedAssistantIntent;
    decision?: PlannerDecision;
    action?: ResolvedAction;
    error?: unknown;
    resolutionError?: ResolutionFailure;
    reply?: string | null;
    extra?: Record<string, unknown>;
  },
) {
  const payload: Record<string, unknown> = {
    ...(params.message ? baseMessagePayload(params.message) : {}),
    ...(params.parsed ? { parsed: summarizeParsedIntent(params.parsed) } : {}),
    ...(params.decision ? { decision: summarizePlannerDecision(params.decision) } : {}),
    ...(params.action ? { action: summarizeAction(params.action) } : {}),
    ...(params.resolutionError ? { resolutionError: summarizeResolutionFailure(params.resolutionError) } : {}),
    ...(typeof params.reply !== 'undefined' ? { reply: truncate(params.reply ?? '') } : {}),
    ...(params.extra ?? {}),
  };

  if (params.error) {
    payload.error =
      params.error instanceof Error
        ? { name: params.error.name, message: truncate(params.error.message, 240) }
        : { message: truncate(String(params.error), 240) };
  }

  console.log(`[assistant.${event}] ${JSON.stringify(payload)}`);
}
