// src/interactions/buttons/play.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Message,
  TextChannel,
} from 'discord.js';
import prisma from '../../db/prisma.js';
import { clickStore } from '../../services/clickStore.js';
import { PeiwanStatus, QuotationCode } from '@prisma/client';
import {
  buildQuotationSelect,
  buildGiftingSelect,
  sent_MP_embed,
  refuse_order_request_embed,
  DEFAULT_GIFTS,
} from '../../ui/orderEmbeds.js';

const stripRoleMentions = (text: string) =>
  text.replace(/<@&\d+>/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+/g, '\n').trim();

// 可选：无法 DM 时的“备用频道”
const FALLBACK_CHANNEL_ID = process.env.ORDER_DM_FALLBACK_CHANNEL_ID ?? '';

/** 构建“抢单(n)”按钮行（保持 customId = requestOrder:<orderId>:<ownerId>） */
function makePlayRow(count: number, orderId: string, ownerId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`requestOrder:${orderId}:${ownerId}`)
      .setStyle(ButtonStyle.Success)
      .setLabel(`抢单(${count})`)
  );
}

function numberOrZero(x: any): number {
  if (!x) return 0;
  if (typeof x === 'number') return x;
  const s = typeof x.toString === 'function' ? x.toString() : `${x}`;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const PRICE_FIELD_BY_CODE: Record<QuotationCode, string> = {
  Q1: 'quotation_Q1',
  Q2: 'lolPrice',
  Q3: 'valPrice',
  Q4: 'deltaPrice',
  Q5: 'csgoPrice',
  Q6: 'narakaPrice',
  Q7: 'apexPrice',
};

/** Map peiwan pricing to QuotationCode => price (nullable allowed for hidden options) */
function pricesFromPeiwan(peiwan: any): Partial<Record<QuotationCode, number | null>> {
  return {
    Q1: numberOrZero(peiwan[PRICE_FIELD_BY_CODE.Q1]) || null,
    Q2: numberOrZero(peiwan[PRICE_FIELD_BY_CODE.Q2]) || null,
    Q3: numberOrZero(peiwan[PRICE_FIELD_BY_CODE.Q3]) || null,
    Q4: numberOrZero(peiwan[PRICE_FIELD_BY_CODE.Q4]) || null,
    Q5: numberOrZero(peiwan[PRICE_FIELD_BY_CODE.Q5]) || null,
    Q6: numberOrZero(peiwan[PRICE_FIELD_BY_CODE.Q6]) || null,
    Q7: numberOrZero(peiwan[PRICE_FIELD_BY_CODE.Q7]) || null,
  };
}

const sanitizeOrderContent = (text: string): string =>
  stripRoleMentions(text).slice(0, 1024);

function extractOrderContent(message: Message | null | undefined): string {
  if (!message) return '';
  const embed = message.embeds?.[0];
  const contentField = embed?.fields?.find((field) => (field.name ?? '').trim() === '订单内容');
  if (contentField?.value) {
    const value = String(contentField.value).trim();
    if (value) return sanitizeOrderContent(value);
  }

  const description = embed?.description ?? '';
  if (description) {
    const quoteMatch = description.match(/“([\s\S]+?)”/);
    if (quoteMatch) {
      const text = quoteMatch[1].trim();
      if (text) return sanitizeOrderContent(text);
    }
    const lines = description
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length) {
      const lastLine = lines[lines.length - 1]
        .replace(/^["“]+|["”]+$/g, '')
        .trim();
      if (lastLine) return sanitizeOrderContent(lastLine);
    }
  }

  const rawContent = message.content ?? '';
  if (rawContent) {
    const quoteMatch = rawContent.match(/“([\s\S]+?)”/);
    if (quoteMatch) {
      const text = quoteMatch[1].trim();
      if (text) return sanitizeOrderContent(text);
    }
    return sanitizeOrderContent(rawContent.trim());
  }

  return '';
}

/* ================== 同一订单的“已点击陪玩集合”（重复点击静默） ================== */
const clickedByOrder = new Map<string, Set<string>>(); // orderId -> Set<workerId>
function alreadyClicked(orderId: string, workerId: string): boolean {
  const set = clickedByOrder.get(orderId);
  return !!set && set.has(workerId);
}
function markClicked(orderId: string, workerId: string) {
  let set = clickedByOrder.get(orderId);
  if (!set) {
    set = new Set<string>();
    clickedByOrder.set(orderId, set);
  }
  set.add(workerId);
}

async function sendMpToBossWithFallback(
  i: ButtonInteraction,
  hostId: string,
  payload: { embeds: any[]; components: any[] },
  orderId: string,
  workerMention: string
): Promise<'dm' | 'fallback-channel' | 'private-thread' | 'failed'> {
  // 1) 尝试 DM 老板
  try {
    const bossUser = await i.client.users.fetch(hostId);
    await bossUser.send(payload);
    return 'dm';
  } catch (e: any) {
    // 50007: Cannot send messages to this user
    if (e?.code !== 50007) throw e;
  }

  // 2) 降级 A：备用频道
  if (FALLBACK_CHANNEL_ID) {
    try {
      const ch = await i.client.channels.fetch(FALLBACK_CHANNEL_ID);
      if (ch && ch.type === ChannelType.GuildText) {
        await (ch as TextChannel).send({
          content: `<@${hostId}> 你的私信关闭了，以下为 ${workerMention} 的名片。`,
          ...payload,
        });
        return 'fallback-channel';
      }
    } catch (err) {
      console.error('[sendMpToBossWithFallback] fallback channel failed:', err);
    }
  }

  // 3) 降级 B：当前频道创建私密线程并拉人
  try {
    if (i.channel && i.channel.type === ChannelType.GuildText) {
      const parent = i.channel as TextChannel;
      const thread = await parent.threads.create({
        name: `订单-${orderId}`,
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        invitable: false,
      });
      await thread.members.add(hostId).catch(() => null);
      await thread.members.add(i.user.id).catch(() => null);

      await thread.send({
        content: `<@${hostId}> 你的私信关闭了，以下为 ${workerMention} 的名片。`,
        ...payload,
      });
      return 'private-thread';
    }
  } catch (err) {
    console.error('[sendMpToBossWithFallback] private thread failed:', err);
  }

  return 'failed';
}

/**
 * 抢单按钮逻辑（重复点击静默）：
 * - customId = requestOrder:<orderId>:<ownerId>
 * - 立刻 deferUpdate，避免超时
 * - 如果该陪玩之前已点击过这个订单 → 直接 return（不提示、不计数、不发 MP）
 * - 首次点击才会：计数 + 更新按钮 + 发送 MP（含降级）
 * - 成功后：机器人**私信陪玩**确认；若陪玩关闭私信，则发一条 ephemeral 提示
 */
export async function handlePlayButton(i: ButtonInteraction) {
  try {
    if (!i.isButton()) return;
    if (!i.customId.startsWith('requestOrder:')) return;

    // 解析 customId
    // requestOrder:<orderId>:<ownerId>
    const parts = i.customId.split(':');
    const orderId = parts[1];
    const ownerId = parts[2] || 'unknown';

    // 立即 ACK（就算后面静默返回也不会超时）
    if (!i.deferred && !i.replied) {
      await i.deferUpdate();
    }

    // 基本校验
    if (!orderId || !ownerId || ownerId === 'unknown') return;
    if (ownerId === i.client.user?.id) return; // 防御：避免写成机器人自己
    if (i.user.id === ownerId) return;         // 老板不能抢自己单（静默）

    const workerId = i.user.id;

    // 重复点击静默处理
    if (alreadyClicked(orderId, workerId)) {
      return;
    }

    // 首次点击：先标记，后续点击将静默
    markClicked(orderId, workerId);

    // 计数并更新按钮（记得把 ownerId 写回 customId）
    clickStore.init(orderId, ownerId);
    const res = clickStore.addClick(orderId, workerId);
    if (res) {
      try {
        const row = makePlayRow(res.count, orderId, ownerId);
        if (i.message.editable) {
          await i.message.edit({ components: [row] });
        }
      } catch (e) {
        console.error('[handlePlayButton] edit components failed:', e);
      }
    }

    // 取陪玩档案
    let peiwan: any = null;
    try {
      peiwan = await prisma.pEIWAN.findUnique({ where: { discordUserId: workerId } });
    } catch (e) {
      console.error('[handlePlayButton] prisma error:', e);
    }
    if (!peiwan) {
      return; // 静默：未注册陪玩则不做后续动作
    }

    // 忙碌：静默忽略此次抢单
    if (peiwan.status !== PeiwanStatus.free) {
      return;
    }

    // 价格 + 礼物下拉（通过 pricesFromPeiwan 生成，类型正确）
    const prices = pricesFromPeiwan(peiwan);
    const giftsForSelect = DEFAULT_GIFTS as Array<{ GiftName: string; price: number }>;

    const realnameBox = buildQuotationSelect('REALNAME', prices);
    const anonymousBox = buildQuotationSelect('ANON', prices);
    const realnameGiftBox = buildGiftingSelect('REALNAME', giftsForSelect as any);
    const anonymousGiftBox = buildGiftingSelect('ANON', giftsForSelect as any);

    const mpUrl: string | null = peiwan.MP_url ?? null;
    const isTech: boolean = !!peiwan.techTag;
    const orderContent = extractOrderContent(i.message as Message);

    const { embed, components } = sent_MP_embed(
      isTech,
      peiwan.PEIWANID,
      `<@${workerId}>`,
      orderContent,
      mpUrl,
      realnameBox,
      anonymousBox,
      realnameGiftBox,
      anonymousGiftBox
    );

    // 发送 MP 到老板（含降级）
    try {
      await sendMpToBossWithFallback(
        i,
        ownerId,
        { embeds: [embed], components },
        orderId,
        `<@${workerId}>`
      );
    } catch (err) {
      console.error('[handlePlayButton] send MP failed:', err);
      // 尝试私信陪玩失败信息；如 DM 也失败，再发一条 ephemeral
      try {
        await i.user.send('报名失败：未能把你的抢单信息发送给老板，请联系客服。');
      } catch {
        if (!i.replied) {
          await i.followUp({
            content: '报名失败：未能把你的抢单信息发送给老板，请联系客服。',
            ephemeral: true,
          });
        }
      }
      return;
    }

    // 成功：机器人私信陪玩确认；若陪玩关闭私信，则发一条 ephemeral 提示
    try {
      await i.user.send('抢单成功，已私信老板发送你的名片，等待老板选择。');
    } catch {
      if (!i.replied) {
        await i.followUp({
          content: '抢单成功，但我无法私信你（请开启“允许服务器成员向你发送私信”）。',
          ephemeral: true,
        });
      }
    }
  } catch (err) {
    console.error('[handlePlayButton] fatal error:', err);
    // 静默：不向用户回帖
  }
}

