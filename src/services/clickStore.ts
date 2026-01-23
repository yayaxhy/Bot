export type ClickState = {
  ownerId: string;
  userIds: Set<string>;
  messages: Array<{ channelId: string; messageId: string }>;
};

class ClickStore {
  private map = new Map<string, ClickState>();

  init(messageId: string, ownerId: string) {
    const existing = this.map.get(messageId);
    if (!existing) {
      this.map.set(messageId, { ownerId, userIds: new Set(), messages: [] });
    } else if (!existing.ownerId) {
      existing.ownerId = ownerId;
    }
  }

  registerMessage(orderId: string, messageId: string, channelId: string, ownerId: string) {
    this.init(orderId, ownerId);
    const state = this.map.get(orderId);
    if (!state) return;
    const exists = state.messages.some(
      (m) => m.channelId === channelId && m.messageId === messageId
    );
    if (!exists) {
      state.messages.push({ channelId, messageId });
    }
  }

  get(messageId: string) {
    return this.map.get(messageId);
  }

  count(messageId: string) {
    const state = this.map.get(messageId);
    return state ? state.userIds.size : 0;
  }

  addClick(messageId: string, userId: string) {
    const state = this.map.get(messageId);
    if (!state) return null;
    const before = state.userIds.size;
    state.userIds.add(userId);
    const after = state.userIds.size;
    return {
      added: after > before,
      count: after,
      ownerId: state.ownerId,
      messages: [...state.messages],
    };
  }

  /**
   * 获取最新一条派单（按消息 ID 最大值）及其关联消息列表
   */
  latestForOwner(ownerId: string): { orderId: string; messages: Array<{ channelId: string; messageId: string }> } | null {
    let latest: { orderId: string; messages: Array<{ channelId: string; messageId: string }> } | null = null;

    for (const [orderId, state] of this.map.entries()) {
      if (state.ownerId !== ownerId) continue;
      if (!latest) {
        latest = { orderId, messages: [...state.messages] };
        continue;
      }
      // Discord snowflake 越大越新
      const currentId = BigInt(orderId);
      const latestId = BigInt(latest.orderId);
      if (currentId > latestId) {
        latest = { orderId, messages: [...state.messages] };
      }
    }

    return latest;
  }
}

export const clickStore = new ClickStore();
