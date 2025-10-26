import { Client, EmbedBuilder, TextChannel, userMention } from "discord.js";

export type GiftPayload = {
  giverId: string;        // user A
  receiverId: string;     // user B
  giftName: string;
  quantity: number;
  totalAmount: number;
  imageUrl?: string;      // <-- make optional
};

export async function postGiftFeed(client: Client, payload: GiftPayload) {
  const channelId = process.env.GIFT_FEED_CHANNEL_ID;
  if (!channelId) throw new Error("GIFT_FEED_CHANNEL_ID is not set.");

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Gift feed channel not found or not text-based.");
  }

  const content =
    `laoban ${userMention(payload.giverId)} gifted peiwan ` +
    `${userMention(payload.receiverId)} "${payload.giftName}", thank you so much!`;

  const embed = new EmbedBuilder()
    .setColor(0xfee9a8)
    .setDescription([
      `**${payload.giftName}**`,               // first line: name
      `数量：**${payload.quantity}**`,          // second line: quantity
      `总金额：**${payload.totalAmount}**`,     // third line: total
    ].join("\n"));

  // Only attach the picture (don’t print its URL in description)
  if (payload.imageUrl && /^https?:\/\/\S+$/i.test(payload.imageUrl)) {
    embed.setImage(payload.imageUrl);
  }

  await (channel as TextChannel).send({ content, embeds: [embed] });
}
