import { Client, EmbedBuilder, TextChannel, userMention } from "discord.js";

export type GiftPayload = {
  giverId: string;        // user A
  receiverId: string;     // user B
  giftName: string;
  quantity: number;
  totalAmount: number;
  imageUrl?: string;      // <-- make optional
  anonymous?: boolean;
};

export async function postGiftFeed(client: Client, payload: GiftPayload) {
  const channelId = process.env.GIFT_FEED_CHANNEL_ID;
  if (!channelId) return;

  let channel: any = null;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err: any) {
    if (err?.code === 50001 || err?.message?.includes('Missing Access')) return;
    console.error('[gift-feed] fetch failed:', err);
    return;
  }
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const giverLabel = payload.anonymous ? '匿名' : userMention(payload.giverId);
  const adminMentions = (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => `<@${id}>`)
    .join(' ');
  const everyonePrefix = payload.totalAmount >= 888 && adminMentions
    ? `${adminMentions} `
    : '';
  const content =
    `${everyonePrefix} 感谢${giverLabel} 老板送给陪玩 ` +
    `${userMention(payload.receiverId)} "${payload.giftName}", 感谢老板对陪陪的喜爱`;

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

  try {
    await (channel as TextChannel).send({ content, embeds: [embed] });
  } catch (err: any) {
    if (err?.code === 50001 || err?.message?.includes('Missing Access')) return;
    console.error('[gift-feed] send failed:', err);
  }
}
