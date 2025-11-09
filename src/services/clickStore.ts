export type ClickState = {
  ownerId: string;
  userIds: Set<string>;
};

class ClickStore {
  private map = new Map<string, ClickState>();

  init(messageId: string, ownerId: string) {
    if (!this.map.has(messageId)) {
      this.map.set(messageId, { ownerId, userIds: new Set() });
    }
  }

  get(messageId: string) {
    return this.map.get(messageId);
  }

  addClick(messageId: string, userId: string) {
    const state = this.map.get(messageId);
    if (!state) return null;
    const before = state.userIds.size;
    state.userIds.add(userId);
    const after = state.userIds.size;
    return { added: after > before, count: after, ownerId: state.ownerId };
  }
}

export const clickStore = new ClickStore();
