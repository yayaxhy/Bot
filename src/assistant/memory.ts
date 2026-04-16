import type { ConversationState, ParsedAssistantIntent, PendingConfirmation, PendingFollowUp, ResolvedAction } from './types.js';

const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const CONFIRM_TTL_MS = 3 * 60 * 1000;
const FOLLOW_UP_TTL_MS = 10 * 60 * 1000;

const conversationStore = new Map<string, ConversationState>();
const confirmationStore = new Map<string, PendingConfirmation>();
const followUpStore = new Map<string, PendingFollowUp>();

function makeConversationKey(userId: string, channelId: string) {
  return `${userId}:${channelId}`;
}

function now() {
  return Date.now();
}

export function getConversationState(userId: string, channelId: string): ConversationState | null {
  const key = makeConversationKey(userId, channelId);
  const state = conversationStore.get(key);
  if (!state) return null;
  if (state.updatedAt + CONVERSATION_TTL_MS < now()) {
    conversationStore.delete(key);
    return null;
  }
  return state;
}

export function rememberResolvedAction(
  userId: string,
  channelId: string,
  action: ResolvedAction,
) {
  const state: ConversationState = {
    updatedAt: now(),
    lastIntent: action.kind,
  };

  if ('order' in action) {
    state.lastOrderId = action.order.id;
    state.lastOrderDisplayNo = action.order.displayNo;
    state.lastWorkerId = action.order.workerId;
    state.lastPeiwanId = action.order.peiwanId;
  }

  if (action.kind === 'gift.send') {
    state.lastWorkerId = action.worker.workerId;
    state.lastPeiwanId = action.worker.peiwanId ?? undefined;
  }

  if (action.kind === 'order.create') {
    state.lastWorkerId = action.worker.workerId;
    state.lastPeiwanId = action.worker.peiwanId ?? undefined;
  }

  const key = makeConversationKey(userId, channelId);
  const previous = conversationStore.get(key);
  conversationStore.set(key, {
    ...previous,
    ...state,
  });
}

export function createPendingConfirmation(
  userId: string,
  channelId: string,
  action: ResolvedAction,
  prompt: string,
) {
  const key = makeConversationKey(userId, channelId);
  confirmationStore.set(key, {
    userId,
    channelId,
    action,
    prompt,
    expiresAt: now() + CONFIRM_TTL_MS,
    });
}

export function attachPendingConfirmationMessageId(
  userId: string,
  channelId: string,
  messageId: string,
) {
  const key = makeConversationKey(userId, channelId);
  const pending = confirmationStore.get(key);
  if (!pending) return;
  confirmationStore.set(key, {
    ...pending,
    messageId,
  });
}

export function getPendingConfirmation(userId: string, channelId: string): PendingConfirmation | null {
  const key = makeConversationKey(userId, channelId);
  const pending = confirmationStore.get(key);
  if (!pending) return null;
  if (pending.expiresAt < now()) {
    confirmationStore.delete(key);
    return null;
  }
  return pending;
}

export function clearPendingConfirmation(userId: string, channelId: string) {
  confirmationStore.delete(makeConversationKey(userId, channelId));
}

export function pendingConfirmationKey(userId: string, channelId: string) {
  return makeConversationKey(userId, channelId);
}

export function createPendingFollowUp(
  userId: string,
  channelId: string,
  parsed: ParsedAssistantIntent,
  prompt: string,
) {
  followUpStore.set(makeConversationKey(userId, channelId), {
    userId,
    channelId,
    parsed,
    prompt,
    expiresAt: now() + FOLLOW_UP_TTL_MS,
  });
}

export function getPendingFollowUp(userId: string, channelId: string): PendingFollowUp | null {
  const key = makeConversationKey(userId, channelId);
  const pending = followUpStore.get(key);
  if (!pending) return null;
  if (pending.expiresAt < now()) {
    followUpStore.delete(key);
    return null;
  }
  return pending;
}

export function clearPendingFollowUp(userId: string, channelId: string) {
  followUpStore.delete(makeConversationKey(userId, channelId));
}
