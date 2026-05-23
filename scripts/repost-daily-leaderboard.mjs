#!/usr/bin/env node

import dotenv from 'dotenv';
import { Client, Events, GatewayIntentBits } from 'discord.js';

dotenv.config();

if (process.env.DATABASE_URLreal) {
  process.env.DATABASE_URL = process.env.DATABASE_URLreal;
}

const dateLabel = (process.argv[2] ?? '').trim();
if (!dateLabel) {
  console.error('Usage: node scripts/repost-daily-leaderboard.mjs YYYY-MM-DD');
  process.exit(1);
}

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

const [{ parseLeaderboardDateLabel, repostDailyLeaderboard }, prismaModule] = await Promise.all([
  import('../dist/services/leaderboardService.js'),
  import('../dist/db/prisma.js'),
]);

const prisma = prismaModule.default;
const targetDayStart = parseLeaderboardDateLabel(dateLabel);
if (!targetDayStart) {
  console.error(`Invalid Rome leaderboard date: ${dateLabel}`);
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

try {
  await new Promise((resolve, reject) => {
    const onReady = () => {
      client.off(Events.ClientReady, onReady);
      resolve(null);
    };
    client.once(Events.ClientReady, onReady);
    client.login(process.env.DISCORD_TOKEN).catch(reject);
  });

  const result = await repostDailyLeaderboard(client, targetDayStart);

  console.log(
    JSON.stringify(
      {
        dateLabel: result.dateLabel,
        allOk: result.allOk,
        spendTop: result.spendTop.map((entry, idx) => ({
          rank: idx + 1,
          discordUserId: entry.discordUserId,
          displayName: entry.displayName,
          amount: entry.deltaSpent.toString(),
        })),
        incomeTop: result.incomeTop.map((entry, idx) => ({
          rank: idx + 1,
          discordUserId: entry.discordUserId,
          displayName: entry.displayName,
          amount: entry.deltaEarn.toString(),
        })),
      },
      null,
      2
    )
  );

  if (!result.allOk) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('[repost-daily-leaderboard] failed', error);
  process.exitCode = 1;
} finally {
  client.destroy();
  await prisma.$disconnect().catch(() => {});
}
