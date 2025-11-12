import { ButtonInteraction, TextChannel, DMChannel, NewsChannel } from 'discord.js';  // Import specific channel types
import prisma from '../../db/prisma.js';  // Correct prisma import
import { order_end_boss_embed } from '../../ui/orderEmbeds.js';  // Correct import for the embed

export const cancelOrder = async (interaction: ButtonInteraction) => {
  const userId = interaction.user.id;
  const orderId = interaction.message.embeds[0]?.footer?.text; // Assuming orderId is in the embed footer

  if (!orderId) {
    return interaction.reply('Order ID not found.');
  }

  // Ensure interaction.channel is not null and is one of the valid channel types that supports 'send'
  if (!interaction.channel || !(interaction.channel instanceof TextChannel || interaction.channel instanceof DMChannel || interaction.channel instanceof NewsChannel)) {
    return interaction.reply('Unable to send the message. No valid text channel found.');
  }

  // Update order status to canceled and grab display number for notifications
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'CANCELED' },
    select: { displayNo: true },
  });

  // Send cancel confirmation to user
  await interaction.channel.send({
    embeds: [order_end_boss_embed(updated.displayNo, null, '—', 0, 0, 0, 0, 0)] // Provide default values for the embed (or fetch relevant data)
  });

  interaction.reply('You have canceled the order.');
};
