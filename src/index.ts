import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Interaction
} from 'discord.js';
import { CONFIG } from './config.js';
import { handlePlayButton } from './interactions/buttons/play.js';
import * as messageCreate from './events/messageCreate.js';
import { registerGiftingCommand } from './commands/gifting.js';
import prisma from './db/prisma.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.on(messageCreate.name, messageCreate.execute);

client.on(Events.InteractionCreate, async (i: Interaction) => {
  if (!i.isButton()) return;
  if (i.customId.startsWith('play:')) return handlePlayButton(i);
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

registerGiftingCommand(client, prisma);

console.log('DB:', process.env.DATABASE_URL);
// once at startup to sanity-check
const giftCount = await prisma.gift.count();
console.log('Gift rows in this DB:', giftCount);
console.log('[Gifts]', await prisma.gift.findMany({ select: { GiftName: true, price: true } }));



client.login(CONFIG.token);
