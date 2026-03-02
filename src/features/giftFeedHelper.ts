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

const HIGH_VALUE_GIFT_FEED_CHANNEL_ID = '1475724021709668414';
const HIGH_VALUE_GIFT_THRESHOLD = 800;
const HIGH_VALUE_NOTIFY_USER_ID = '1421651539247894549';

async function sendGiftFeedMessage(
  client: Client,
  channelId: string,
  payload: GiftPayload,
) {
  if (!channelId) return;

  let channel: any = null;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err: any) {
    if (err?.code === 50001 || err?.message?.includes('Missing Access')) return;
    console.error('[gift-feed] fetch failed:', { channelId, err });
    return;
  }
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const giverLabel = payload.anonymous ? '匿名' : userMention(payload.giverId);
  const mentionPrefix =
    channelId === HIGH_VALUE_GIFT_FEED_CHANNEL_ID && HIGH_VALUE_NOTIFY_USER_ID
      ? `${userMention(HIGH_VALUE_NOTIFY_USER_ID)} `
      : '';
  const content =
    mentionPrefix +
    `感谢${giverLabel} 老板送给陪玩 ` +
    `${userMention(payload.receiverId)} "${payload.giftName}", 感谢老板对陪陪的喜爱`;

  const embed = new EmbedBuilder()
    .setColor(0xfee9a8)
    .setDescription([
      `**${payload.giftName}**`,
      `数量：**${payload.quantity}**`,
      `总金额：**${payload.totalAmount}**`,
    ].join("\n"));

  if (payload.imageUrl && /^https?:\/\/\S+$/i.test(payload.imageUrl)) {
    embed.setImage(payload.imageUrl);
  }

  try {
    await (channel as TextChannel).send({ content, embeds: [embed] });
  } catch (err: any) {
    if (err?.code === 50001 || err?.message?.includes('Missing Access')) return;
    console.error('[gift-feed] send failed:', { channelId, err });
  }
}

export async function postGiftFeed(client: Client, payload: GiftPayload) {
  const channelId = process.env.GIFT_FEED_CHANNEL_ID;
  if (!channelId) return;

  await sendGiftFeedMessage(client, channelId, payload);

  if (
    payload.totalAmount >= HIGH_VALUE_GIFT_THRESHOLD &&
    HIGH_VALUE_GIFT_FEED_CHANNEL_ID &&
    HIGH_VALUE_GIFT_FEED_CHANNEL_ID !== channelId
  ) {
    await sendGiftFeedMessage(client, HIGH_VALUE_GIFT_FEED_CHANNEL_ID, payload);
  }
}
