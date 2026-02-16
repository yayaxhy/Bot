import { ChannelType, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { isCashAdmin } from './cash.js';

export const channelMessageCommand = new SlashCommandBuilder()
  .setName('频道消息')
  .setDescription('向指定频道发送一条自定义消息（仅管理员）')
  .addChannelOption((option) =>
    option
      .setName('频道')
      .setDescription('要发送到的频道')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
  )
  .addStringOption((option) =>
    option
      .setName('内容')
      .setDescription('要发送的消息内容')
      .setRequired(true)
      .setMaxLength(1900)
  );

export async function handleChannelMessageSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '频道消息') return;

  await i.deferReply({ ephemeral: true });

  if (!isCashAdmin(i)) {
    await i.editReply('❌ 你没有权限使用该命令。');
    return;
  }

  const targetChannel = i.options.getChannel('频道', true);
  const content = i.options.getString('内容', true).trim();

  if (!content) {
    await i.editReply('❌ 消息内容不能为空。');
    return;
  }

  const fetchedChannel = await i.client.channels.fetch(targetChannel.id);
  if (!fetchedChannel || !fetchedChannel.isSendable()) {
    await i.editReply('❌ 目标频道不是文本频道。');
    return;
  }

  try {
    await fetchedChannel.send({ content });
    await i.editReply(`✅ 已发送到 <#${targetChannel.id}>。`);
  } catch (err) {
    console.error('[channelMessage] send failed', {
      guildId: i.guildId,
      operatorId: i.user.id,
      channelId: targetChannel.id,
      err,
    });
    await i.editReply('❌ 发送失败，请检查机器人在该频道的发送权限。');
  }
}
