import { EmbedBuilder, type Client } from 'discord.js';

const LOTTERY_FUSION_WEB_NOTIFY_CHANNEL_ID =
  process.env.LOTTERY_FUSION_WEB_NOTIFY_CHANNEL_ID ?? '1421498686491328603';

export const buildLotteryFusionBotSuccessMessage = (prizeName: string) =>
  `恭喜您🎉 重铸获得${prizeName}`;

export const buildLotteryFusionWebSuccessMessage = (params: {
  prizeName: string;
  discordUserId?: string | null;
  fallbackUserLabel?: string | null;
}) => {
  const { prizeName, discordUserId, fallbackUserLabel } = params;
  const userLabel = discordUserId
    ? `<@${discordUserId}>`
    : fallbackUserLabel?.trim()
      ? fallbackUserLabel.trim()
      : '该用户';
  return `恭喜用户 ${userLabel} 🎉 重铸获得${prizeName}`;
};

export const buildLotteryFusionSuccessEmbed = (prizeName: string) =>
  new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle('奖品重铸成功')
    .setDescription(buildLotteryFusionBotSuccessMessage(prizeName))
    .setTimestamp(new Date());

export async function sendLotteryFusionSuccessDm(params: {
  client: Client;
  discordUserId?: string | null;
  prizeName: string;
}) {
  const { client, discordUserId, prizeName } = params;
  if (!discordUserId) return;

  try {
    const user = await client.users.fetch(discordUserId).catch(() => null);
    if (!user) return;
    await user.send({ embeds: [buildLotteryFusionSuccessEmbed(prizeName)] });
  } catch (err) {
    console.error('[lottery-fusion] DM failed', {
      discordUserId,
      prizeName,
      err,
    });
  }
}

export async function announceLotteryFusionWebSuccess(params: {
  client: Client;
  prizeName: string;
  discordUserId?: string | null;
  fallbackUserLabel?: string | null;
}) {
  const { client, prizeName, discordUserId, fallbackUserLabel } = params;
  if (!LOTTERY_FUSION_WEB_NOTIFY_CHANNEL_ID) return;

  try {
    const channel = await client.channels
      .fetch(LOTTERY_FUSION_WEB_NOTIFY_CHANNEL_ID)
      .catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    await (channel as any).send({
      content: buildLotteryFusionWebSuccessMessage({
        prizeName,
        discordUserId,
        fallbackUserLabel,
      }),
      allowedMentions: discordUserId ? { users: [discordUserId] } : { parse: [] },
    });
  } catch (err) {
    console.error('[lottery-fusion] web announce failed', {
      discordUserId,
      prizeName,
      err,
    });
  }
}
