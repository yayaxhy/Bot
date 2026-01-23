export type ClickState = {
  ownerId: string;
  userIds: Set<string>;
  messages: Array<{ channelId: string; messageId: string; kind: 'hint' | 'body' }>;
};

class ClickStore {
  private map = new Map<string, ClickState>();
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly persistPath: string;

  constructor() {
    const defaultPath = path.join(process.cwd(), 'clickstore-state.json');
    this.persistPath = process.env.CLICKSTORE_PATH ?? defaultPath;
    this.loadFromDisk().catch((err) => {
      console.warn('[clickStore] failed to load persisted state:', err);
    });
  }

  private schedulePersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => this.persist().catch((err) => {
      console.warn('[clickStore] persist error:', err);
    }), 200);
  }

  private async persist() {
    const entries = Array.from(this.map.entries()).map(([orderId, state]) => ({
      orderId,
      ownerId: state.ownerId,
      userIds: Array.from(state.userIds),
      messages: state.messages,
    }));
    await fs.promises.writeFile(this.persistPath, JSON.stringify({ entries }), 'utf8');
  }

  private async loadFromDisk() {
    try {
      const raw = await fs.promises.readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as { entries?: Array<{ orderId: string; ownerId: string; userIds: string[]; messages: Array<{ channelId: string; messageId: string; kind: 'hint' | 'body' }> }> };
      if (!data?.entries) return;
      for (const entry of data.entries) {
        const state: ClickState = {
          ownerId: entry.ownerId,
          userIds: new Set(entry.userIds ?? []),
          messages: Array.isArray(entry.messages) ? entry.messages : [],
        };
        this.map.set(entry.orderId, state);
      }
      console.log('[clickStore] restored state entries:', data.entries.length);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return; // no persisted state yet
      throw err;
    }
  }

  init(messageId: string, ownerId: string) {
    const existing = this.map.get(messageId);
    if (!existing) {
      this.map.set(messageId, { ownerId, userIds: new Set(), messages: [] });
    } else if (!existing.ownerId) {
      existing.ownerId = ownerId;
    }
  }

  registerMessage(orderId: string, messageId: string, channelId: string, ownerId: string, kind: 'hint' | 'body' = 'body') {
    this.init(orderId, ownerId);
    const state = this.map.get(orderId);
    if (!state) return;
    const exists = state.messages.some(
      (m) => m.channelId === channelId && m.messageId === messageId
    );
    if (!exists) {
      state.messages.push({ channelId, messageId, kind });
      this.schedulePersist();
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
    if (after !== before) {
      this.schedulePersist();
    }
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

  getMessages(orderId: string, kind?: 'hint' | 'body') {
    const state = this.map.get(orderId);
    if (!state) return [];
    if (!kind) return [...state.messages];
    return state.messages.filter((m) => m.kind === kind);
  }

  remove(orderId: string) {
    if (this.map.delete(orderId)) {
      this.schedulePersist();
    }
  }
}

export const clickStore = new ClickStore();
