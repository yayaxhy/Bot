import type { ConversationState } from './types.js';

export function buildAssistantSystemPrompt() {
  return [
    '你是 Discord 订单助手的 NLU 层，只负责把用户消息解析成 JSON。',
    '只识别以下意图：dispatch.create、order.create、invite.accept、invite.decline、order.end、gift.send、balance.query、worker.id.query、help.query、unknown。',
    '不要编造数据库 ID；用户如果说“刚才那单”“上一单”“她”，请输出引用类型，不要臆造具体对象。',
    'dispatch.create 用于用户想派单、发单、帮忙找陪玩。',
    'order.create 用于用户想给某位陪玩点单。',
    'gift.send 只在用户明确表达“打赏/送礼”时识别。',
    'balance.query 只在用户明确询问余额、剩余金额时识别。',
    'worker.id.query 用于用户明确询问自己的陪玩编号、陪玩ID。',
    'help.query 用于用户明确询问“怎么点单/怎么打赏/怎么派单/你能做什么”这类帮助问题。',
    'invite.accept / invite.decline 只在陪玩回复接单/不接单一类消息时识别。',
    'order.end 只在明确要结单/结束订单时识别。',
    'dispatchGame 填游戏，如“瓦”“LoL”“OW”；dispatchRank 填“黄金/铂金/钻石”等；genderPreference 填“小姐姐/小哥哥”；companionType 填“技术/娱乐/大神”。',
    'helpTopic 用于 help.query，可填 dispatch.create、order.create、gift.send、balance.query、order.end、invite.accept、invite.decline、worker.id.query、general。',
    'softPreferences 仅放软偏好，如“活泼”“话多”“温柔”“会聊天”。',
    'orderContent 放剩余需要展示给陪玩的备注内容。',
    '无法确定时返回 unknown，并把 confidence 降低。',
  ].join('\n');
}

export function buildAssistantUserPrompt(params: {
  content: string;
  conversation: ConversationState | null;
  nowIso: string;
}) {
  const { content, conversation, nowIso } = params;
  return JSON.stringify(
    {
      nowIso,
      latestConversation: conversation
        ? {
            lastIntent: conversation.lastIntent ?? null,
            lastOrderId: conversation.lastOrderId ?? null,
            lastWorkerId: conversation.lastWorkerId ?? null,
            lastPeiwanId: conversation.lastPeiwanId ?? null,
            lastOrderDisplayNo: conversation.lastOrderDisplayNo ?? null,
          }
        : null,
      message: content,
      referenceHints: {
        currentOrderWorker: '“她/他/当前陪玩/这个陪玩”通常可理解为当前订单或最近订单中的陪玩',
        latestRunningOrder: '“刚才那单/当前那单”通常倾向最近进行中的订单',
        latestPendingInvitation: '“接单/拒单”默认指最近待处理邀请',
      },
    },
    null,
    2,
  );
}
