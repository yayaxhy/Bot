// src/index.ts
import { Client, GatewayIntentBits, Partials, Interaction, Events } from 'discord.js';
import dotenv from 'dotenv';
import { handlePlayButton } from './interactions/buttons/play.js';
import { execute as messageCreateHandler } from './events/messageCreate.js';
import { registerGiftingCommand } from './commands/gifting.js';
import prisma from './db/prisma.js';
import { registerCashCommand } from './commands/cash.js';
import { recoverAllTimers } from './services/timerService.js';
import { handleOrderPriceSelect } from './interactions/buttons/orderPriceSelect.js';
import { handleAcceptOrder } from './interactions/buttons/acceptOrder.js';
import { handleDeclineOrder } from './interactions/buttons/declineOrder.js';
import { handleEndOrderButton } from './interactions/buttons/endOrder.js';
import { handleGiftingSelect } from './interactions/selects/giftingSelect.js';
import { handleDiscountSelect } from './interactions/selects/discountSelect.js';
import { registerTotalEarnCommand } from './commands/totalEarn.js';
import { grantCouponCommand, handleGrantCouponSlash } from './commands/grantCouponSlash.js';
import { startInternalWebhookServer } from './server/internalWebhookServer.js';
import { startWithdrawWatcher } from './services/withdrawalWatcher.js';
import { startPeiwanWatcher } from './services/peiwanWatcher.js';
import { registerTechTagSync } from './services/techTagService.js';
import { startRechargeWatcher } from './services/rechargeWatcher.js';


dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

(globalThis as any).__CLIENT__ = client;

// message create
client.on(Events.MessageCreate, messageCreateHandler);

// interaction router
client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    // String select for price (实名/匿名点单)
    if (i.isStringSelectMenu()) {
      if (i.customId === 'realname_box' || i.customId === 'anonymous_box') {
        await handleOrderPriceSelect(i);
        return;
      }
      if (i.customId === 'realname_gifting_box' || i.customId === 'anonymous_gifting_box') {
        await handleGiftingSelect(i);
        return;
      }
      if (i.customId.startsWith('discount_box')) {
        await handleDiscountSelect(i);
        return;
      }
    }

    if (i.isChatInputCommand()) {
      if (i.commandName === '送券') {
        await handleGrantCouponSlash(i);
        return;
      }
    }

    // Buttons
    if (i.isButton()) {
      // 抢单按钮
      if (i.customId?.startsWith('requestOrder:') || i.customId?.startsWith('play:')) {
        await handlePlayButton(i);
        return;
      }

      // 接受 / 拒绝 邀请
      if (i.customId === 'invite_accept' || i.customId.startsWith('invite:accept')) {
        await handleAcceptOrder(i);
        return;
      }
      if (i.customId === 'invite_decline' || i.customId.startsWith('invite:decline')) {
        await handleDeclineOrder(i);
        return;
      }
      if (i.customId.startsWith('order:end:')) {
        await handleEndOrderButton(i);
        return;
      }
    }
  } catch (err) {
    console.error('[InteractionCreate] error:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content: '操作失败，请稍后再试。', ephemeral: true }); } catch {}
    }
  }
});



registerTechTagSync(client);

client.once(Events.ClientReady, async () => {
  console.log(`[ready] Logged in as ${client.user?.tag}`);
  await recoverAllTimers();
  registerGiftingCommand(client, prisma);
  registerCashCommand(client, prisma);
  registerTotalEarnCommand(client, prisma);
  try {
    if (client.application) {
      await client.application.commands.create(grantCouponCommand);
    }
  } catch (err) {
    console.error('[slash] register error:', err);
  }
  startInternalWebhookServer();
  startWithdrawWatcher().catch((err) => console.error('[withdraw.watch] init failed', err));
  startPeiwanWatcher().catch((err) => console.error('[peiwan.watch] init failed', err));
  startRechargeWatcher().catch((err) => console.error('[recharge.watch] init failed', err));
});

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

client.login(process.env.DISCORD_TOKEN);
