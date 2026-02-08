import { ButtonInteraction } from 'discord.js';
import { SCRATCH_SYSTEM_ID, revealScratchTicket } from '../../services/scratchService.js';
import { buildScratchRevealButton, buildScratchRevealedEmbed } from '../../ui/scratchEmbeds.js';

const PREFIX = 'scratch:reveal:';

function parseTicketId(customId: string | null | undefined) {
  if (!customId || !customId.startsWith(PREFIX)) return null;
  return customId.slice(PREFIX.length) || null;
}

export async function handleScratchRevealButton(i: ButtonInteraction) {
  if (!i.isButton()) return;
  const ticketId = parseTicketId(i.customId);
  if (!ticketId) return;

  await i.deferUpdate().catch(() => {});

  try {
    const result = await revealScratchTicket({
      ticketId,
      userId: i.user.id,
      revealMessageId: i.message?.id,
      counterpartyId: i.client.user?.id ?? SCRATCH_SYSTEM_ID,
    });

    if (result.status === 'not_found') {
      await i.followUp({ content: '刮刮乐不存在或状态异常。', ephemeral: true }).catch(() => {});
      return;
    }
    if (result.status === 'forbidden') {
      return;
    }

    const ticket = result.ticket;
    const revealEmbed = buildScratchRevealedEmbed({
      code: ticket.code,
      buyerId: i.user.id,
      prizeType: ticket.prizeType,
      prizeAmount: ticket.prizeAmount.toString(),
    });
    const disabledRow = buildScratchRevealButton(ticket.id, true);

    await i.message.edit({
      embeds: [revealEmbed],
      components: [disabledRow],
    }).catch(() => {});
  } catch (err) {
    console.error('[scratch] reveal failed:', err);
    await i.followUp({ content: '刮开失败，请稍后再试。', ephemeral: true }).catch(() => {});
  }
}
