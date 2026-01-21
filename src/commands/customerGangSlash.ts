import { ChatInputCommandInteraction, SlashCommandBuilder, TextChannel, userMention } from 'discord.js';
import {
  ongoing_order_request_embed,
  anonymous_ongoing_order_request_embed,
  order_request_sent_successfully_embed,
} from '../ui/orderEmbeds.js';
import { scheduleOrderRequestClosure } from '../services/orderInteractionManager.js';
import { recordOrderRequest } from '../services/orderRequestLogService.js';

const SUPPORT_USER_IDS = new Set(['1421651539247894549', '525770714574225408', '794340158991237121']);
const ORDER_CHANNEL_ID = '1421495114928492604';
const ROLE_MALE = '1430923554852962406';
const ROLE_FEMALE = '1430923008045744211';
const ROLE_TECH = '1430923746830581841';

export const customerGangCommand = new SlashCommandBuilder()
  .setName('客服帮派')
  .setDescription('客服代老板派单（可匿名/实名）')
  .addUserOption((opt) =>
    opt.setName('老板').setDescription('要帮派单的老板').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('内容').setDescription('派单内容').setRequired(true)
  )
  .addBooleanOption((opt) =>
    opt.setName('匿名').setDescription('是否匿名派单（默认实名）').setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt.setName('男陪陪').setDescription('是否@男陪陪（1430923554852962406）').setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt.setName('女陪陪').setDescription('是否@女陪陪（1430923008045744211）').setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt.setName('技术陪玩').setDescription('是否@技术陪玩（1430923746830581841）').setRequired(false)
  );

export async function handleCustomerGangSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '客服帮派') return;

  if (!SUPPORT_USER_IDS.has(i.user.id)) {
    await i.reply({ content: '❌ 仅客服可用。', ephemeral: true });
    return;
  }

  const boss = i.options.getUser('老板', true);
  const content = i.options.getString('内容', true);
  const isAnonymous = i.options.getBoolean('匿名') ?? false;
  const pingMale = i.options.getBoolean('男陪陪') ?? false;
  const pingFemale = i.options.getBoolean('女陪陪') ?? false;
  const pingTech = i.options.getBoolean('技术陪玩') ?? false;

  const roleMentions: string[] = [];
  const allowedRoleIds: string[] = [];
  if (pingMale) { roleMentions.push(`<@&${ROLE_MALE}>`); allowedRoleIds.push(ROLE_MALE); }
  if (pingFemale) { roleMentions.push(`<@&${ROLE_FEMALE}>`); allowedRoleIds.push(ROLE_FEMALE); }
  if (pingTech) { roleMentions.push(`<@&${ROLE_TECH}>`); allowedRoleIds.push(ROLE_TECH); }

  const mentionLine = roleMentions.join(' ').trim();
  const messageText = [mentionLine, content].filter(Boolean).join(' ').trim();

  const channel = await i.client.channels.fetch(ORDER_CHANNEL_ID).catch(() => null);
  if (!channel || !(channel instanceof TextChannel)) {
    await i.reply({ content: '派单失败：未找到派单频道。', ephemeral: true });
    return;
  }

  const orderId = i.id; // 与正常派单一致，使用交互 ID
  const ownerId = boss.id;

  try {
    await i.deferReply({ ephemeral: true });

    let ownerDisplayName: string | null = null;
    if (channel.guild) {
      ownerDisplayName = channel.guild.members.cache.get(boss.id)?.displayName ?? null;
      if (!ownerDisplayName) {
        ownerDisplayName = await channel.guild.members
          .fetch(boss.id)
          .then((m) => m.displayName)
          .catch(() => null);
      }
    }

    await channel.send({ content: '老板派单啦，快来抢单' });
    const embedPayload = isAnonymous
      ? anonymous_ongoing_order_request_embed(
          messageText,
          content,
          orderId,
          ownerId
        )
      : ongoing_order_request_embed(
          boss.tag,
          messageText,
          content,
          orderId,
          ownerId
        );

    const posted = await channel.send({
      ...embedPayload,
      content: messageText,
      allowedMentions: { users: [], roles: allowedRoleIds, parse: [] },
    });
    scheduleOrderRequestClosure(posted);
    recordOrderRequest({
      orderId,
      ownerId,
      content: messageText,
      ownerDisplayName: ownerDisplayName ?? null,
    }).catch(() => {});

    const { embed: successEmbed, components: successComponents } = order_request_sent_successfully_embed(orderId, ownerId);
    await boss.send({ content: '订单创建成功！', embeds: [successEmbed], components: successComponents }).catch(() => null);

    await i.editReply({ content: '派单已发送。' });
  } catch (err) {
    console.error('[客服帮派] failed', err);
    try {
      await i.editReply({ content: '派单失败，请稍后再试。' });
    } catch {}
  }
}
