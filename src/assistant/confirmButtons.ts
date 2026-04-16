import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  type InteractionUpdateOptions,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import { executeAssistantAction } from './executor.js';
import { logAssistantEvent } from './logger.js';
import {
  attachPendingConfirmationMessageId,
  clearPendingConfirmation,
  getPendingConfirmation,
  pendingConfirmationKey,
  rememberResolvedAction,
} from './memory.js';

const CONFIRM_BUTTON_ID = 'assistant:confirm';
const CANCEL_BUTTON_ID = 'assistant:cancel';

const confirmationTimers = new Map<string, NodeJS.Timeout>();

function buildConfirmationRow(disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CONFIRM_BUTTON_ID)
      .setLabel('确认执行')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CANCEL_BUTTON_ID)
      .setLabel('取消操作')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

export function buildAssistantConfirmationPayload(prompt: string): MessageCreateOptions {
  return {
    content: prompt,
    components: [buildConfirmationRow(false)],
    allowedMentions: { parse: [] },
  };
}

export function buildAssistantDisabledConfirmationPayload(content: string): InteractionUpdateOptions {
  return {
    content,
    components: [buildConfirmationRow(true)],
  };
}

function timerKey(userId: string, channelId: string) {
  return pendingConfirmationKey(userId, channelId);
}

function clearConfirmationTimer(userId: string, channelId: string) {
  const key = timerKey(userId, channelId);
  const timer = confirmationTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    confirmationTimers.delete(key);
  }
}

async function expireConfirmation(message: Message, userId: string, channelId: string) {
  const pending = getPendingConfirmation(userId, channelId);
  if (!pending || pending.messageId !== message.id) return;

  clearPendingConfirmation(userId, channelId);
  clearConfirmationTimer(userId, channelId);
  try {
    if (message.editable) {
      await message.edit({
        content: '这次操作已过期，请重新发起。',
        components: [buildConfirmationRow(true)],
      });
    }
    logAssistantEvent('confirm_expired', {
      action: pending.action,
      extra: {
        userId,
        channelId,
        messageId: message.id,
      },
    });
  } catch (err) {
    logAssistantEvent('confirm_expire_failed', {
      action: pending.action,
      error: err,
      extra: {
        userId,
        channelId,
        messageId: message.id,
      },
    });
  }
}

export async function registerAssistantConfirmationMessage(
  userId: string,
  channelId: string,
  message: Message,
) {
  attachPendingConfirmationMessageId(userId, channelId, message.id);
  clearConfirmationTimer(userId, channelId);
  const pending = getPendingConfirmation(userId, channelId);
  if (!pending) return;
  const delay = Math.max(0, pending.expiresAt - Date.now());
  confirmationTimers.set(
    timerKey(userId, channelId),
    setTimeout(() => {
      expireConfirmation(message, userId, channelId);
    }, delay),
  );
}

function matchesPending(i: ButtonInteraction, pendingMessageId?: string) {
  if (!pendingMessageId) return true;
  return i.message.id === pendingMessageId;
}

function formatAssistantError(err: unknown) {
  const text = err instanceof Error ? err.message : String(err ?? '');
  if (text.includes('ORDER_NOT_ASSIGNED_TO_WORKER')) return '这笔邀请不是发给你的。';
  if (text.includes('ORDER_NOT_PENDING')) return '这笔订单已经处理过了。';
  if (text.includes('Order not running')) return '这笔订单现在不是进行中，暂时不能结单。';
  if (text.includes('余额不足')) return text;
  if (text.includes('礼物不存在')) return text;
  if (text.includes('不能给自己打赏')) return text;
  if (text.includes('陪玩繁忙')) return '对方当前繁忙，暂时不能处理这笔邀请。';
  return '处理失败了，请稍后再试。';
}

export async function handleAssistantConfirmationButton(i: ButtonInteraction) {
  if (!i.customId.startsWith('assistant:')) return false;

  const pending = getPendingConfirmation(i.user.id, i.channelId);
  if (!pending || !matchesPending(i, pending.messageId)) {
    await i.update(buildAssistantDisabledConfirmationPayload('这条确认已经失效，请重新发起操作。'));
    return true;
  }

  clearConfirmationTimer(i.user.id, i.channelId);

  if (i.customId === CANCEL_BUTTON_ID) {
    clearPendingConfirmation(i.user.id, i.channelId);
    logAssistantEvent('button_cancelled', {
      action: pending.action,
      extra: {
        interactionId: i.id,
        userId: i.user.id,
        channelId: i.channelId,
      },
    });
    await i.update(buildAssistantDisabledConfirmationPayload('本次操作已取消。'));
    return true;
  }

  clearPendingConfirmation(i.user.id, i.channelId);
  await i.update(buildAssistantDisabledConfirmationPayload('已确认，正在处理...'));
  try {
    const reply = await executeAssistantAction(i, pending.action);
    rememberResolvedAction(i.user.id, i.channelId, pending.action);
    logAssistantEvent('button_executed', {
      action: pending.action,
      reply,
      extra: {
        interactionId: i.id,
        userId: i.user.id,
        channelId: i.channelId,
      },
    });
    if (reply) {
      await i.followUp({ content: reply, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    logAssistantEvent('button_execute_failed', {
      action: pending.action,
      error: err,
      extra: {
        interactionId: i.id,
        userId: i.user.id,
        channelId: i.channelId,
      },
    });
    await i.followUp({ content: formatAssistantError(err), allowedMentions: { parse: [] } });
  }
  return true;
}
