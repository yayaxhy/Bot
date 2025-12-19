import { ChatInputCommandInteraction, SlashCommandBuilder, TextChannel, userMention } from 'discord.js';
import { ongoing_order_request_embed, order_request_sent_successfully_embed } from '../ui/orderEmbeds.js';
import { scheduleOrderRequestClosure } from '../services/orderInteractionManager.js';

const SUPPORT_USER_ID = '1421651539247894549';
const ORDER_CHANNEL_ID = '1421495114928492604';
const ROLE_MALE = '1430923554852962406';
const ROLE_FEMALE = '1430923008045744211';
const ROLE_TECH = '1430923746830581841';

export const customerGangCommand = new SlashCommandBuilder()
  .setName('客服帮派')
  .setDescription('客服代老板派单（匿名帮派）')
  .addUserOption((opt) =>
    opt.setName('老板').setDescription('要帮派单的老板').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('内容').setDescription('派单内容').setRequired(true)
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

  if (i.user.id !== SUPPORT_USER_ID) {
    await i.reply({ content: '❌ 仅客服可用。', ephemeral: true });
    return;
  }

  const boss = i.options.getUser('老板', true);
  const content = i.options.getString('内容', true);
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

    await channel.send({ content: '老板派单啦，快来抢单' });
    const embedPayload = ongoing_order_request_embed(
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

    const { embed: successEmbed } = order_request_sent_successfully_embed(orderId);
    await boss.send({ content: '订单创建成功！', embeds: [successEmbed] }).catch(() => null);

    await i.editReply({ content: '派单已发送。' });
  } catch (err) {
    console.error('[客服帮派] failed', err);
    try {
      await i.editReply({ content: '派单失败，请稍后再试。' });
    } catch {}
  }
}
