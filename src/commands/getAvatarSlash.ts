import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';

export const getAvatarCommand = new SlashCommandBuilder()
  .setName('获取头像')
  .setDescription('获取指定用户的头像')
  .addUserOption((option) =>
    option
      .setName('用户')
      .setDescription('要查看头像的用户')
      .setRequired(true),
  );

export async function handleGetAvatarSlash(i: ChatInputCommandInteraction) {
  if (i.commandName !== '获取头像') return;

  const target = i.options.getUser('用户', true);
  const avatarUrl = target.displayAvatarURL({ size: 1024, forceStatic: false });

  const embed = new EmbedBuilder()
    .setTitle(`${target.username} 的头像`)
    .setImage(avatarUrl);

  await i.reply({ embeds: [embed], ephemeral: false });
}
