import { Client, Message } from 'discord.js';
import {
  parseScratchCode,
  purchaseScratchTicket,
  SCRATCH_SYSTEM_ID,
} from '../services/scratchService.js';
import { buildScratchPendingEmbed, buildScratchRevealButton } from '../ui/scratchEmbeds.js';

const COMMAND = '!刮刮乐';
const MENTION_RE = /^<@!?\d+>$/;

const sendToChannel = async (channel: Message['channel'], payload: any) => {
  if (!channel || typeof (channel as any).send !== 'function') return null;
  return (channel as any).send(payload);
};

export function registerScratchCommand(client: Client) {
  client.on('messageCreate', async (msg: Message) => {
    try {
      if (msg.author.bot) return;
      const content = msg.content.trim();
      if (!content.startsWith(COMMAND)) return;
      if (!msg.guild || !msg.channel) {
        await msg.reply('请在服务器频道中使用该命令。');
        return;
      }

      const parts = content.split(/\s+/);
      const args = parts.slice(1);
      const targetUser = msg.mentions.users.first() ?? null;
      const targetUserId = targetUser?.id ?? msg.author.id;
      if (targetUser?.bot) {
        await sendToChannel(msg.channel, '不能赠送给机器人。');
        return;
      }

      const rawCode = args.find((arg) => !MENTION_RE.test(arg)) ?? null;

      let requestedCode: string | null = null;
      if (rawCode) {
        requestedCode = parseScratchCode(rawCode);
        if (!requestedCode) {
          await sendToChannel(msg.channel, '号码不存在');
          return;
        }
      }

      const result = await purchaseScratchTicket({
        userId: msg.author.id,
        ownerId: targetUserId,
        requestedCode,
        counterpartyId: client.user?.id ?? SCRATCH_SYSTEM_ID,
      });

      if (result.status === 'insufficient') {
        await sendToChannel(msg.channel, '余额不足！');
        return;
      }
      if (result.status === 'sold_out') {
        await sendToChannel(msg.channel, '刮刮乐已售罄。');
        return;
      }
      if (result.status === 'code_not_found') {
        await sendToChannel(msg.channel, '号码不存在');
        return;
      }
      if (result.status === 'code_sold') {
        await sendToChannel(msg.channel, '该号码已售出');
        return;
      }

      const pendingEmbed = buildScratchPendingEmbed({
        code: result.ticket.code,
        buyerId: targetUserId,
        amount: result.purchaseAmount.toString(),
      });
      const buttonRow = buildScratchRevealButton(result.ticket.id, false);

      const sent = await sendToChannel(msg.channel, {
        embeds: [pendingEmbed],
        components: [buttonRow],
      });

      if (!sent) return;
    } catch (err) {
      console.error('[scratch] create failed:', err);
      try {
        await msg.reply('刮刮乐创建失败，请稍后再试。');
      } catch {}
    }
  });
}
