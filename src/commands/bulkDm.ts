import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  Role,
  GuildMember,
  TextBasedChannel,
  DiscordAPIError,
} from 'discord.js';
import { isCashAdmin } from './cash.js';

const CONFIRM_CHANNEL_ID = '1465700782622900317';
const BASE_DELAY_MS = 1000;
const JITTER_MS = 500;
const COOLDOWN_EVERY = 10;
const COOLDOWN_MS = 7000;
const SEND_MAX_RETRY = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hasSend = (channel: unknown): channel is TextBasedChannel & { send: Function } =>
  !!channel && typeof (channel as any).send === 'function';
const isOnline = (member: GuildMember): boolean => {
  const status = member.presence?.status;
  if (!status) return false;
  return status !== 'offline' && status !== 'invisible';
};

function normalizeContent(text: string): string {
  return text.trim();
}

async function getConfirmChannel(i: ChatInputCommandInteraction): Promise<TextBasedChannel | null> {
  try {
    const channel = await i.client.channels.fetch(CONFIRM_CHANNEL_ID);
    if (channel && channel.isTextBased()) return channel;
  } catch (err) {
    console.error('[bulkdm] fetch confirm channel failed', err);
  }
  return null;
}

async function sendWithRetry(member: GuildMember, content: string) {
  let attempt = 0;
  while (attempt < SEND_MAX_RETRY) {
    attempt += 1;
    try {
      await member.send({ content });
      return { ok: true as const };
    } catch (err: any) {
      const is429 = err instanceof DiscordAPIError && err.status === 429;
      const retryAfter = is429
        ? Number((err as any)?.rawError?.retry_after ?? (err as any)?.retryAfter ?? 0)
        : 0;
      if (is429 && retryAfter > 0 && attempt < SEND_MAX_RETRY) {
        await sleep(retryAfter * 1000 + 200);
        continue;
      }
      return {
        ok: false as const,
        error: err,
      };
    }
  }
  return { ok: false as const, error: new Error('retry_exhausted') };
}

export const bulkDmCommand = new SlashCommandBuilder()
  .setName('派单私信')
  .setDescription('按角色批量私信指定内容')
  .addStringOption((option) =>
    option
      .setName('信息')
      .setDescription('要发送的文本')
      .setRequired(true)
      .setMaxLength(1800)
  )
  .addRoleOption((option) =>
    option
      .setName('tag')
      .setDescription('要发送给的tag')
      .setRequired(true)
  )
  .addRoleOption((option) =>
    option
      .setName('tag2')
      .setDescription('可选，需同时拥有此tag')
      .setRequired(false)
  )
  .addRoleOption((option) =>
    option
      .setName('tag3')
      .setDescription('可选，需同时拥有此tag')
      .setRequired(false)
  );

export async function handleBulkDmSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '派单私信') return;

  if (!i.inCachedGuild()) {
    await i.reply({ content: '❌ 只能在服务器内使用该命令。', ephemeral: true });
    return;
  }

  if (!isCashAdmin(i)) {
    await i.reply({ content: '❌ 你没有权限使用该命令。', ephemeral: true });
    return;
  }

  const message = normalizeContent(i.options.getString('信息', true));
  const roles = [
    i.options.getRole('角色', true) as Role,
    i.options.getRole('角色2') as Role | null,
    i.options.getRole('角色3') as Role | null,
  ].filter(Boolean) as Role[];

  // 确保拉取成员列表
  await i.guild!.members.fetch({ withPresences: true });
  const allMembers = i.guild!.members.cache.values();
  const targets = Array.from(allMembers).filter((m) => {
    if (m.user.bot) return false;
    if (!isOnline(m)) return false;
    return roles.every((r) => m.roles.cache.has(r.id));
  });

  if (targets.length === 0) {
    await i.reply({ content: '未找到在线的目标成员（可能全部离线或未启用 Presence Intent）。', ephemeral: false });
    return;
  }

  await i.reply({
    content: `开始向 ${targets.length} 名成员发送私信（需同时具备 ${roles.length} 个角色）…… 私信内容：${message}`,
    ephemeral: false,
  });

  const confirmChannel = await getConfirmChannel(i);
  let success = 0;
  let failure = 0;
  let idx = 0;

  for (const member of targets) {
    idx += 1;

    const sendResult = await sendWithRetry(member, message);
    const ok = sendResult.ok;
    if (!ok && confirmChannel && hasSend(confirmChannel)) {
      const baseContent = `${message} 对 <@${member.id}> 发送失败`;
      try {
        await confirmChannel.send({ content: baseContent });
      } catch (err) {
        console.error('[bulkdm] confirm send failed', err);
      }
    }

    if (ok) {
      success += 1;
    } else {
      failure += 1;
      const err = (sendResult as any).error;
      if (err) console.error('[bulkdm] dm failed', { userId: member.id, err });
    }

    // 节流：基准 1s + 抖动
    const delay = BASE_DELAY_MS + Math.floor(Math.random() * JITTER_MS);
    await sleep(delay);
    if (idx % COOLDOWN_EVERY === 0) {
      await sleep(COOLDOWN_MS);
    }
  }

  await i.followUp({
    content: `完成。成功 ${success} 人，失败 ${failure} 人，总计 ${targets.length} 人。`,
    ephemeral: false,
  });
}
