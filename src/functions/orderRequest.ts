import {
  Interaction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  TextChannel,
  DMChannel,
  NewsChannel,
} from 'discord.js';
import {
  ongoing_order_request_embed,
  anonymous_ongoing_order_request_embed,
  order_request_sent_successfully_embed,
} from '../ui/orderEmbeds.js';
import prisma from '../db/prisma.js';
import { recordOrderRequest } from '../services/orderRequestLogService.js';
import { updateMemberServerDisplayName } from '../services/memberDisplayNameService.js';
import { getActiveActivities } from '../services/activityService.js';
import { getDispatchImageUrlForOwner } from '../services/orderDispatchImageService.js';

export async function sendOrderRequest(interaction: Interaction) {
  const userA = interaction.user;
  const ownerId = userA.id;                 // 🔴 明确的老板 ID
  const orderId = (interaction as any).id ?? `${Date.now()}`;

  let message = '';
  if (interaction instanceof ChatInputCommandInteraction) {
    message = interaction.options.getString('message') ?? '';
  } else if (interaction instanceof ButtonInteraction) {
    message = (interaction.message as any)?.content ?? '';
  }
  const activities = await getActiveActivities();

  const rolesMentioned =
    interaction instanceof ButtonInteraction
      ? (interaction.message as any)?.mentions?.roles
      : undefined;

  if (rolesMentioned && rolesMentioned.size > 0) {
    if (
      interaction.channel &&
      (interaction.channel instanceof TextChannel ||
      interaction.channel instanceof DMChannel ||
        interaction.channel instanceof NewsChannel)
    ) {
      const dispatchImageUrl = await getDispatchImageUrlForOwner(ownerId);
      const embedResponse = ongoing_order_request_embed(
        userA.tag, message, message, orderId, ownerId, undefined, activities, dispatchImageUrl  // 🔴 传 ownerId
      );
      const ownerDisplayName =
        interaction.member && typeof interaction.member === 'object' && 'displayName' in interaction.member
          ? (interaction.member.displayName as string | undefined)
          : null;
      updateMemberServerDisplayName(prisma, ownerId, ownerDisplayName).catch(() => {});
      recordOrderRequest({
        orderId,
        ownerId,
        content: message,
        ownerDisplayName,
      }).catch(() => {});
      await interaction.channel.send(embedResponse);
    }
  } else {
    const embedResponse = anonymous_ongoing_order_request_embed(
      message, message, orderId, ownerId, undefined, activities
    );
    const ownerDisplayName =
      interaction.member && typeof interaction.member === 'object' && 'displayName' in interaction.member
        ? (interaction.member.displayName as string | undefined)
        : null;
    updateMemberServerDisplayName(prisma, ownerId, ownerDisplayName).catch(() => {});
    recordOrderRequest({
      orderId,
      ownerId,
      content: message,
      ownerDisplayName,
    }).catch(() => {});
    await userA.send(embedResponse);
  }

  const { embed, components } = order_request_sent_successfully_embed(orderId, ownerId, activities);
  await userA.send({ embeds: [embed], components });
}
