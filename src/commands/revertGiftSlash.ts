import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { revertGiftByIndividualTx } from '../services/revertGiftService.js';
import { isCashAdmin } from './cash.js';

export const revertGiftCommand = new SlashCommandBuilder()
  .setName('撤回打赏')
  .setDescription('根据打赏流水号撤销一笔打赏（仅客服/管理员可用）')
  .addStringOption((opt) =>
    opt.setName('transaction_id').setDescription('individualTransaction.transactionId (IT...)').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('reason').setDescription('撤销原因').setRequired(false)
  );

export async function handleRevertGiftSlash(i: ChatInputCommandInteraction) {
  if (!isCashAdmin(i)) {
    await i.reply({ content: '❌ 你没有权限执行撤销。', ephemeral: true });
    return;
  }

  const txId = i.options.getString('transaction_id', true).trim();
  const reason = i.options.getString('reason') ?? undefined;

  try {
    await revertGiftByIndividualTx({ transactionId: txId, operatorId: i.user.id, reason });
    await i.reply({ content: `已尝试撤销打赏流水 ${txId}，请留意余额和通知。`, ephemeral: true });
  } catch (err: any) {
    const msg =
      err?.message === 'already_reverted'
        ? '该打赏已撤销过。'
        : err?.message === 'gift_not_found'
        ? '未找到对应的打赏审计记录。'
        : '撤销失败，请稍后重试。';
    await i.reply({ content: msg, ephemeral: true });
  }
}
