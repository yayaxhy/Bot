import { Client, Message } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { handleRedEnvelopeMessage } from '../commands/redEnvelope.js';
import { handleKeywordRedEnvelopeMessage } from '../commands/keywordRedEnvelope.js';
import { tryClaimKeywordEnvelopeFromMessage } from '../services/redEnvelopeService.js';

export function registerRedEnvelopeMessageHandlers(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg: Message) => {
    try {
      if (msg.author.bot) return;

      if (await handleRedEnvelopeMessage(msg, prisma)) return;
      if (await handleKeywordRedEnvelopeMessage(msg, prisma)) return;
      await tryClaimKeywordEnvelopeFromMessage(msg, prisma);
    } catch (err) {
      console.error('[red-envelope messageCreate] error:', err);
    }
  });
}
