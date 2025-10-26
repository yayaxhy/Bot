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

client.login(CONFIG.token);
