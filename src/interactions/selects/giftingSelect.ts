import { StringSelectMenuInteraction, MessageCreateOptions } from 'discord.js';
import prisma from '../../db/prisma.js';
import { performGift } from '../../commands/gifting.js';
import { giftBox_success } from '../../ui/orderEmbeds.js';
import { updateMemberServerDisplayName } from '../../services/memberDisplayNameService.js';

const PEIWAN_ID_FIELD_NAMES = new Set(['PEIWANID', '陪玩ID']);
const isPeiwanIdFieldName = (name?: string | null) => {
  if (!name) return false;
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  return PEIWAN_ID_FIELD_NAMES.has(trimmed) || PEIWAN_ID_FIELD_NAMES.has(upper);
};

export async function handleGiftingSelect(i: StringSelectMenuInteraction) {
  if (!i.isStringSelectMenu()) return;
  if (i.customId !== 'realname_gifting_box' && i.customId !== 'anonymous_gifting_box') return;

  const giftName = i.values?.[0];
  if (!giftName) {
    if (i.replied || i.deferred) {
      await i.editReply({ content: '未能识别礼物，请重新选择。' });
    } else {
      await i.reply({ content: '未能识别礼物，请重新选择。', ephemeral: true });
    }
    return;
  }

  const embed = i.message.embeds?.[0];
  const field = embed?.fields?.find((f) => isPeiwanIdFieldName(f.name));
  const match = field?.value ? String(field.value).match(/\d+/) : null;
  const peiwanId = match ? Number(match[0]) : NaN;

  const respond = async (payload: string | MessageCreateOptions) => {
    const options = typeof payload === 'string' ? { content: payload } : payload;
    const hasFiles = Array.isArray((options as any)?.files) && (options as any).files.length > 0;
    const shouldBeEphemeral = !!i.guildId && !hasFiles;
    const finalOptions = shouldBeEphemeral ? { ...options, ephemeral: true } : options;

    if (i.deferred) {
      await i.editReply(finalOptions as any);
    } else if (i.replied) {
      await i.followUp(finalOptions as any);
    } else if (i.guildId) {
      await i.reply(finalOptions as any);
    } else {
      await i.reply(options as any);
    }
  };

  if (!Number.isInteger(peiwanId)) {
    await respond('未能解析陪玩编号，请稍后再试。');
    return;
  }

  if (!i.deferred && !i.replied) {
    try {
      if (i.guildId) {
        await i.deferReply();
      } else {
        await i.deferReply();
      }
    } catch {}
  }

  try {
    const peiwan = await prisma.pEIWAN.findUnique({
      where: { PEIWANID: peiwanId },
      select: { discordUserId: true },
    });
    if (!peiwan) {
      await respond('未找到该陪玩，无法打赏。');
      return;
    }

    const receiverId = peiwan.discordUserId;
    const giverId = i.user.id;
    if (receiverId === giverId) {
      await respond('不能给自己打赏哦。');
      return;
    }

    const receiverUser = await i.client.users.fetch(receiverId).catch(() => null);
    const giverDisplayName =
      i.member && typeof i.member === 'object' && 'displayName' in i.member
        ? (i.member.displayName as string | undefined)
        : null;
    updateMemberServerDisplayName(prisma, giverId, giverDisplayName).catch(() => {});
    const receiverDisplayName = i.guild?.members.cache.get(receiverId)?.displayName ?? null;
    updateMemberServerDisplayName(prisma, receiverId, receiverDisplayName).catch(() => {});

    const result = await performGift(i.client, prisma, {
      giverId,
      receiverId,
      giftName,
      quantity: 1,
      anonymous: i.customId === 'anonymous_gifting_box',
      giverUsername: i.user.username,
      receiverUsername: receiverUser?.username,
    });

    const successPayload = giftBox_success(
      `<@${receiverId}>`,
      result.quantity.toString(),
      result.giftName
    );

    await respond(successPayload);
  } catch (err: any) {
    console.error('[handleGiftingSelect] error:', err);
    const reason = err?.message ?? '未知错误';
    await respond(`打赏失败：${reason}`);
  }
}
