export type ClickMessageKind = 'hint' | 'body' | 'broadcast';
export type OrderRequestOwnerControl = {
  ownerId: string;
  channelId: string;
  messageId: string;
};

export type ClickState = {
  ownerId: string;
  userIds: Set<string>;
  messages: Array<{ channelId: string; messageId: string; kind: ClickMessageKind }>;
  ownerControls: OrderRequestOwnerControl[];
};

class ClickStore {
  private map = new Map<string, ClickState>();
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly persistPath: string;
  private readonly loadPromise: Promise<void>;

  constructor() {
    const defaultPath = path.join(process.cwd(), 'clickstore-state.json');
    this.persistPath = process.env.CLICKSTORE_PATH ?? defaultPath;
    this.loadPromise = this.loadFromDisk().catch((err) => {
      console.warn('[clickStore] failed to load persisted state:', err);
    });
  }

  ready() {
    return this.loadPromise;
  }

  private pruneDanglingEntries() {
    let pruned = 0;
    for (const [orderId, state] of this.map.entries()) {
      const hasMessages = state.messages.length > 0;
      const hasOwnerControls = state.ownerControls.length > 0;
      const hasClicks = state.userIds.size > 0;
      if (hasMessages || hasOwnerControls || hasClicks) continue;
      this.map.delete(orderId);
      pruned += 1;
    }
    return pruned;
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
      ownerControls: state.ownerControls,
    }));
    await fs.promises.writeFile(this.persistPath, JSON.stringify({ entries }), 'utf8');
  }

  private async loadFromDisk() {
    try {
      const raw = await fs.promises.readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as { entries?: Array<{
        orderId: string;
        ownerId: string;
        userIds: string[];
        messages: Array<{ channelId: string; messageId: string; kind?: string }>;
        ownerControls?: Array<{ ownerId?: string; channelId?: string; messageId?: string }>;
      }> };
      if (!data?.entries) return;
      for (const entry of data.entries) {
        const state: ClickState = {
          ownerId: entry.ownerId,
          userIds: new Set(entry.userIds ?? []),
          messages: Array.isArray(entry.messages)
            ? entry.messages.map((message) => ({
                channelId: message.channelId,
                messageId: message.messageId,
                kind:
                  message.kind === 'hint' || message.kind === 'body' || message.kind === 'broadcast'
                    ? message.kind
                    : 'body',
              }))
            : [],
          ownerControls: Array.isArray(entry.ownerControls)
            ? entry.ownerControls
                .filter((item) => item?.ownerId && item?.channelId && item?.messageId)
                .map((item) => ({
                  ownerId: item.ownerId as string,
                  channelId: item.channelId as string,
                  messageId: item.messageId as string,
                }))
            : [],
        };
        this.map.set(entry.orderId, state);
      }
      const pruned = this.pruneDanglingEntries();
      console.log('[clickStore] restored state entries:', this.map.size);
      if (pruned > 0) {
        console.log('[clickStore] pruned dangling entries:', pruned);
        await this.persist();
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') return; // no persisted state yet
      throw err;
    }
  }

  init(messageId: string, ownerId: string) {
    const existing = this.map.get(messageId);
    if (!existing) {
      this.map.set(messageId, { ownerId, userIds: new Set(), messages: [], ownerControls: [] });
    } else if (!existing.ownerId || (ownerId && existing.ownerId !== ownerId)) {
      existing.ownerId = ownerId;
      this.schedulePersist();
    }
  }

  registerMessage(orderId: string, messageId: string, channelId: string, ownerId: string, kind: ClickMessageKind = 'body') {
    this.init(orderId, ownerId);
    const state = this.map.get(orderId);
    if (!state) return;
    const existing = state.messages.find(
      (m) => m.channelId === channelId && m.messageId === messageId
    );
    if (!existing) {
      state.messages.push({ channelId, messageId, kind });
      this.schedulePersist();
      return;
    }

    if (existing.kind !== kind && existing.kind !== 'broadcast') {
      existing.kind = 'broadcast';
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

  registerOwnerControl(orderId: string, ownerId: string, messageId: string, channelId: string) {
    this.init(orderId, ownerId);
    const state = this.map.get(orderId);
    if (!state) return;
    const exists = state.ownerControls.some(
      (item) => item.ownerId === ownerId && item.channelId === channelId && item.messageId === messageId,
    );
    if (!exists) {
      state.ownerControls.push({ ownerId, channelId, messageId });
      this.schedulePersist();
    }
  }

  getOwnerControls(orderId: string) {
    const state = this.map.get(orderId);
    if (!state) return [];
    return [...state.ownerControls];
  }

  listOpenRequests() {
    return Array.from(this.map.entries()).map(([orderId, state]) => ({
      orderId,
      ownerId: state.ownerId,
      messages: [...state.messages],
      ownerControls: [...state.ownerControls],
    }));
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

  getMessages(orderId: string, kind?: ClickMessageKind) {
    const state = this.map.get(orderId);
    if (!state) return [];
    if (!kind) return [...state.messages];
    return state.messages.filter((message) => {
      if (kind === 'broadcast') return message.kind === 'broadcast';
      if (message.kind === 'broadcast') return true;
      return message.kind === kind;
    });
  }

  remove(orderId: string) {
    if (this.map.delete(orderId)) {
      this.schedulePersist();
    }
  }
}

export const clickStore = new ClickStore();
import fs from 'node:fs';
import path from 'node:path';
