import type { Message } from 'discord.js';
import type { OrderStatus } from '@prisma/client';

export type AssistantIntent =
  | 'dispatch.create'
  | 'order.create'
  | 'invite.accept'
  | 'invite.decline'
  | 'order.end'
  | 'gift.send'
  | 'balance.query'
  | 'worker.id.query'
  | 'help.query'
  | 'unknown';

export type OrderReferenceKind =
  | 'latest_running_order'
  | 'latest_pending_invitation'
  | 'latest_order'
  | 'previous_order'
  | 'explicit_display_no'
  | 'explicit_id';

export type WorkerReferenceKind =
  | 'current_order_worker'
  | 'last_worker'
  | 'yesterday_worker'
  | 'explicit_discord_user_id'
  | 'explicit_peiwan_id'
  | 'memory_worker';

export interface OrderReference {
  kind: OrderReferenceKind;
  raw?: string | null;
}

export interface WorkerReference {
  kind: WorkerReferenceKind;
  raw?: string | null;
}

export interface ParsedAssistantIntent {
  intent: AssistantIntent;
  confidence: number;
  source: 'ai' | 'rule';
  orderReference: OrderReference | null;
  workerReference: WorkerReference | null;
  dispatchGame: string | null;
  dispatchRank: string | null;
  genderPreference: string | null;
  companionType: string | null;
  helpTopic: string | null;
  softPreferences: string[];
  orderContent: string | null;
  giftName: string | null;
  quantity: number | null;
  missingSlots: string[];
  rationale: string | null;
}

export interface ConversationState {
  lastIntent?: AssistantIntent;
  lastOrderId?: string;
  lastWorkerId?: string;
  lastPeiwanId?: number;
  lastOrderDisplayNo?: number | null;
  updatedAt: number;
}

export interface ResolvedOrderTarget {
  id: string;
  displayNo: number | null;
  status: OrderStatus;
  hostId: string | null;
  hostJinleeId: string | null;
  workerId: string;
  peiwanId: number;
}

export interface ResolvedWorkerTarget {
  workerId: string;
  peiwanId: number | null;
  sourceLabel: string;
}

export type ResolutionFailure =
  | { kind: 'missing'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'ambiguous'; message: string };

export type ResolutionResult<T> = { ok: true; value: T } | { ok: false; error: ResolutionFailure };

export type ResolvedAction =
  | {
      kind: 'dispatch.create';
      dispatchGame: string;
      dispatchRank: string | null;
      genderPreference: string | null;
      companionType: string | null;
      softPreferences: string[];
      orderContent: string | null;
    }
  | {
      kind: 'order.create';
      worker: ResolvedWorkerTarget;
      orderContent: string | null;
    }
  | { kind: 'invite.accept'; order: ResolvedOrderTarget }
  | { kind: 'invite.decline'; order: ResolvedOrderTarget }
  | { kind: 'order.end'; order: ResolvedOrderTarget }
  | { kind: 'gift.send'; worker: ResolvedWorkerTarget; giftName: string; quantity: number }
  | { kind: 'balance.query' }
  | { kind: 'worker.id.query' }
  | { kind: 'help.query'; topic: string | null };

export type PlannerDecision =
  | { kind: 'ignore' }
  | { kind: 'reply'; message: string }
  | { kind: 'confirm'; message: string; action: ResolvedAction }
  | { kind: 'execute'; action: ResolvedAction };

export interface PendingConfirmation {
  userId: string;
  channelId: string;
  action: ResolvedAction;
  prompt: string;
  expiresAt: number;
  messageId?: string;
}

export interface PendingFollowUp {
  userId: string;
  channelId: string;
  parsed: ParsedAssistantIntent;
  prompt: string;
  expiresAt: number;
}

export interface AssistantContext {
  message: Message;
  conversation: ConversationState | null;
}
