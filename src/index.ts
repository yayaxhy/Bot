// src/index.ts
import { Client, GatewayIntentBits, Partials, Interaction, Events } from 'discord.js';
import dotenv from 'dotenv';
import { handlePlayButton } from './interactions/buttons/play.js';
import { execute as messageCreateHandler } from './events/messageCreate.js';
import { registerGiftingCommand } from './commands/gifting.js';
import prisma, { prismaReady } from './db/prisma.js';
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
import { handleRegisterPeiwanSlash, registerPeiwanCommand } from './commands/registerPeiwanSlash.js';
import { handleRedEnvelopeSlash, redEnvelopeSlashCommand } from './commands/redEnvelopeSlash.js';
import { startInternalWebhookServer } from './server/internalWebhookServer.js';
import { startWithdrawWatcher } from './services/withdrawalWatcher.js';
import { startPeiwanWatcher } from './services/peiwanWatcher.js';
import { registerTechTagSync } from './services/techTagService.js';
import { startRechargeWatcher } from './services/rechargeWatcher.js';
import { registerRedEnvelopeCommand } from './commands/redEnvelope.js';
import {
  CLAIM_EMOJI_REACTION,
  claimRedEnvelope,
  findEnvelopeByMessage,
  recoverRedEnvelopeSchedules,
  refreshRedEnvelopeMessage,
} from './services/redEnvelopeService.js';


dotenv.config();

await prismaReady.catch((err) => {
  console.error('[startup] prisma warmup failed:', err);
  process.exit(1);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

(globalThis as any).__CLIENT__ = client;

// message create
client.on(Events.MessageCreate, messageCreateHandler);

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (err) {
        console.error('[red-envelope] reaction fetch failed:', err);
        return;
      }
    }

    if (reaction.emoji.name !== CLAIM_EMOJI_REACTION) return;

    const message = reaction.message;
    if (!message || message.partial) {
      try {
        await message.fetch();
      } catch (err) {
        console.error('[red-envelope] message fetch failed:', err);
        return;
      }
    }

    const envelope = await findEnvelopeByMessage(message.id);
    if (!envelope) {
      return;
    }

    const guild = reaction.message.guild;
    let displayName: string | undefined = user.username ?? undefined;
    try {
      if (guild) {
        const member = await guild.members.fetch(user.id);
        displayName = member.displayName || member.user.username || displayName;
      }
    } catch {}

    const claimResult = await claimRedEnvelope(envelope.id, user.id, displayName);

    if (claimResult.status === 'claimed') {
      await refreshRedEnvelopeMessage(client, envelope.id);
      const grossText = Number(claimResult.gross.toString()).toFixed(2);
      const netText = Number(claimResult.amount.toString()).toFixed(2);
      const msgText = `恭喜你锦鲤附体，好运暴击抢到了红包 ¥${grossText}，实际到手 ¥${netText}！`;
      try { await user.send(msgText); } catch {}
    } else if (claimResult.status === 'already_claimed') {
      await refreshRedEnvelopeMessage(client, envelope.id);
      // 重复点击不提示
    } else if (claimResult.status === 'expired') {
      await refreshRedEnvelopeMessage(client, envelope.id);
      // 过期点击静默
    } else if (claimResult.status === 'ended') {
      // 红包已抢完，静默处理
      await refreshRedEnvelopeMessage(client, envelope.id);
    }
  } catch (err) {
    console.error('[red-envelope] reaction handler error:', err);
  }
});

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
            if (i.commandName === '录入陪玩') {
                await handleRegisterPeiwanSlash(i);
                return;
            }
            if (i.commandName === '红包') {
                await handleRedEnvelopeSlash(i);
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
  registerRedEnvelopeCommand(client, prisma);
  try {
        if (client.application) {
            await client.application.commands.create(grantCouponCommand);
            await client.application.commands.create(registerPeiwanCommand);
            await client.application.commands.create(redEnvelopeSlashCommand);
        }
  } catch (err) {
    console.error('[slash] register error:', err);
  }
  await recoverRedEnvelopeSchedules(client);
  startInternalWebhookServer();
  startWithdrawWatcher().catch((err) => console.error('[withdraw.watch] init failed', err));
  startPeiwanWatcher().catch((err) => console.error('[peiwan.watch] init failed', err));
  startRechargeWatcher().catch((err) => console.error('[recharge.watch] init failed', err));
});

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

client.login(process.env.DISCORD_TOKEN);
