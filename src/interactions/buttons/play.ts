import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType
} from 'discord.js';
import type { PlayCustomId } from '../../types.js';
import { clickStore } from '../../services/clickStore.js';

export function makePlayRow(count: number, mirroredMessageId: string) {
  const btn = new ButtonBuilder()
    .setCustomId(`抢单:${mirroredMessageId}`)
    .setStyle(ButtonStyle.Success)
    .setLabel(`抢单(${count})`);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(btn);
}

export async function handlePlayButton(i: ButtonInteraction) {
  const customId = i.customId as PlayCustomId;
  const mirroredMessageId = customId.split(':')[1];

  if (i.componentType !== ComponentType.Button || !mirroredMessageId) {
    return i.reply({ content: 'Invalid interaction.', ephemeral: true });
  }

  const res = clickStore.addClick(mirroredMessageId, i.user.id);
  if (!res) {
    return i.reply({ content: 'This session expired. Ask the author to repost.', ephemeral: true });
  }

  if (!res.added) return i.deferUpdate();

  try {
    const row = makePlayRow(res.count, mirroredMessageId);
    await i.update({ components: [row] });
  } catch {
    await i.deferUpdate();
  }

  try {
    const ownerUser = await i.client.users.fetch(res.ownerId);
    await ownerUser.send(
      `陪陪 **${i.user.tag}** 抢单了. (ID: \`${i.user.id}\`)`
    );
  } catch {
    await i.followUp({ content: 'Notified the author (or their DMs are closed).', ephemeral: true });
  }
}
