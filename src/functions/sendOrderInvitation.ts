import { ongoing_order_request_embed, anonymous_ongoing_order_request_embed, order_request_sent_successfully_embed } from '../ui/orderEmbeds.js'; // Use your custom embeds
import { Client } from 'discord.js';  // To fetch the user object
import prisma from '../db/prisma.js';  // Correct prisma import

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

  // Destructure to get only the embed part
  const { embed } = order_request_sent_successfully_embed(orderId);  // Extract only the embed

  // Send the embed after verifying the user's balance
  await user.send({
    embeds: [embed]  // Use only the embed part from the response
  });
}
