import type { ButtonInteraction, Message } from 'discord.js';
import prisma from '../db/prisma.js';
import { performGift } from '../commands/gifting.js';
import { runOrderAcceptanceFlow } from '../interactions/buttons/acceptOrder.js';
import { runOrderDeclineFlow } from '../interactions/buttons/declineOrder.js';
import { endOrder } from '../services/orderService.js';
import { cancelOrderTimers } from '../services/timerService.js';
import { notifyOrderEnded } from '../services/orderNotificationService.js';
import { isInvitationExpired, markInvitationHandled } from '../services/orderInteractionManager.js';
import { buildAssistantHelpReply } from './helpResponses.js';
import { executeNaturalDispatchCreate, executeNaturalOrderCreate } from './orderActions.js';
import type { ResolvedAction } from './types.js';

function orderLabel(displayNo: number | null, id: string) {
  return displayNo != null ? `#${displayNo}` : id;
}

function actorUser(target: Message | ButtonInteraction) {
  return 'author' in target ? target.author : target.user;
}

export async function executeAssistantAction(
  message: Message | ButtonInteraction,
  action: ResolvedAction,
): Promise<string | null> {
  if (action.kind === 'dispatch.create') {
    await executeNaturalDispatchCreate(message, {
      dispatchGame: action.dispatchGame,
      dispatchRank: action.dispatchRank,
      genderPreference: action.genderPreference,
      companionType: action.companionType,
      softPreferences: action.softPreferences,
      orderContent: action.orderContent,
    });
    return null;
  }

  if (action.kind === 'order.create') {
    await executeNaturalOrderCreate(message, {
      workerId: action.worker.workerId,
      peiwanId: action.worker.peiwanId,
      orderContent: action.orderContent,
    });
    return null;
  }

  if (action.kind === 'balance.query') {
    const user = actorUser(message);
    const member = await prisma.member.findUnique({
      where: { discordUserId: user.id },
      select: { totalBalance: true },
    });
    const balance = member?.totalBalance != null ? Number(member.totalBalance.toString()) : 0;
    const balanceText = Number.isFinite(balance) ? balance.toFixed(2) : '0.00';
    return `你当前余额是 ¥${balanceText}。`;
  }

  if (action.kind === 'worker.id.query') {
    const user = actorUser(message);
    const peiwan = await prisma.pEIWAN.findUnique({
      where: { discordUserId: user.id },
      select: { PEIWANID: true },
    });
    if (!peiwan) {
      return '你当前还没有绑定陪玩身份。';
    }
    return `你的陪玩ID是 ${peiwan.PEIWANID}。`;
  }

  if (action.kind === 'help.query') {
    return buildAssistantHelpReply(action.topic);
  }

  if (action.kind === 'invite.accept') {
    if (isInvitationExpired(action.order.id)) {
      return '这笔邀请已经过期了，请让老板重新派单。';
    }
    await runOrderAcceptanceFlow(message.client, action.order.id);
    await markInvitationHandled(action.order.id);
    return `已帮你接单 ${orderLabel(action.order.displayNo, action.order.id)}。`;
  }

  if (action.kind === 'invite.decline') {
    const user = actorUser(message);
    if (isInvitationExpired(action.order.id)) {
      return '这笔邀请已经过期了，不能再拒绝。';
    }
    await runOrderDeclineFlow(message.client, action.order.id, user.id);
    await markInvitationHandled(action.order.id);
    return `已帮你拒绝订单 ${orderLabel(action.order.displayNo, action.order.id)}。`;
  }

  if (action.kind === 'order.end') {
    const user = actorUser(message);
    await endOrder(action.order.id, user.id);
    cancelOrderTimers(action.order.id);
    try {
      await notifyOrderEnded(action.order.id);
    } catch (err) {
      console.error('[assistant.executor] notifyOrderEnded failed:', err);
    }
    return `已为你结单 ${orderLabel(action.order.displayNo, action.order.id)}。`;
  }

  const user = actorUser(message);
  const receiverUser = await message.client.users.fetch(action.worker.workerId).catch(() => null);
  const result = await performGift(message.client, prisma, {
    giverId: user.id,
    receiverId: action.worker.workerId,
    giftName: action.giftName,
    quantity: action.quantity,
    anonymous: true,
    giverUsername: user.username,
    receiverUsername: receiverUser?.username,
  });
  const gross = Number(result.gross.toString()).toFixed(2);
  return `已为你匿名打赏 ${action.quantity} 个 ${result.giftName}，总价 ¥${gross}。`;
}
