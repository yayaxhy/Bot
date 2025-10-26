import { Events, Message } from 'discord.js';
import { handleMessage as mirrorPlayHandler } from '../features/mirrorPlay/messageHandler.js';

export const name = Events.MessageCreate;
export async function execute(message: Message) {
  return mirrorPlayHandler(message);
}
