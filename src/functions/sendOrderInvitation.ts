import { ongoing_order_request_embed, anonymous_ongoing_order_request_embed, order_request_sent_successfully_embed } from '../ui/orderEmbeds.js'; // Use your custom embeds
import { Client } from 'discord.js';  // To fetch the user object
import prisma from '../db/prisma.js';  // Correct prisma import
import { getActiveActivities } from '../services/activityService.js';

export async function sendOrderInvitation(orderId: string, userId: string, client: Client) {
  // Fetch user details from the Member table (not PEIWAN)
  const userARecord = await prisma.member.findUnique({ where: { discordUserId: userId } });

  if (!userARecord || userARecord.totalBalance.toNumber() < 100) {
    return;  // Ensure the balance check is valid and goes to Member, not PEIWAN
  }

  // Fetch the User object from the Discord client
  const user = await client.users.fetch(userId);

  if (!user) {
    return;  // If user not found, exit early
  }

  const activities = await getActiveActivities();
  const { embed, components } = order_request_sent_successfully_embed(orderId, userId, activities);

  // Send the embed after verifying the user's balance
  await user.send({
    embeds: [embed],
    components,
  });
}
