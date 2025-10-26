import { ChannelType, Message } from 'discord.js';
import { makeRoleMentionPolicy } from '../../policy/policies.js';
import { mirrorPlayConfig } from './featureConfig.js';
import { makeMirrorEmbed } from '../../utils/embeds.js';
import { clickStore } from '../../services/clickStore.js';
import { makePlayRow } from '../../interactions/buttons/play.js';

const policy = makeRoleMentionPolicy({ allowedRoleIds: mirrorPlayConfig.allowedRoleIds });

export async function handleMessage(msg: Message) {
  if (msg.author.bot) return;
  if (msg.channel.type !== ChannelType.GuildText) return;
  if (!policy(msg)) return;

  const botAvatar = msg.client.user?.displayAvatarURL() || undefined;
  const embed = makeMirrorEmbed({
    authorTag: msg.author.tag,
    content: msg.content,
    botAvatarUrl: botAvatar
  });

  const sent = await msg.channel.send({
    embeds: [embed],
    components: [makePlayRow(0, 'temp')]
  });

  clickStore.init(sent.id, msg.author.id);
  await sent.edit({
    components: [makePlayRow(0, sent.id)]
  });
}
