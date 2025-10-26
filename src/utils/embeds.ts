import { APIEmbed, EmbedBuilder } from 'discord.js';

export function makeMirrorEmbed(opts: {
  authorTag: string;
  content: string;
  botAvatarUrl?: string;
}): APIEmbed {
  const embed = new EmbedBuilder()
    .setAuthor({ name: opts.authorTag })
    .setDescription(opts.content || '*<no content>*')
    .setTimestamp(new Date());

  if (opts.botAvatarUrl) {
    embed.setThumbnail(opts.botAvatarUrl);
  }

  return embed.toJSON();
}
