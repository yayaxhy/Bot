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

  // 先占坑，避免 3 秒超时提示（公开回复）
  await i.deferReply({ ephemeral: false }).catch(() => {});

  const txId = i.options.getString('transaction_id', true).trim();
  const reason = i.options.getString('reason') ?? undefined;

  try {
    const result = await revertGiftByIndividualTx({ transactionId: txId, operatorId: i.user.id, reason });
    const refundText = Number(result.payable.toString()).toFixed(2);
    const workerNetText = Number(result.netAmount.toString()).toFixed(2);
    const actionLabel = result.audit.giftName === '真人试音' ? '真人试音' : '打赏';
    const voucherUsed =
      (Array.isArray(result.audit.voucherIds) && result.audit.voucherIds.length > 0) ||
      (Array.isArray((result.audit as any).couponIds) && (result.audit as any).couponIds.length > 0);

    let bossMessage: string;
    if (voucherUsed && refundText === '0.00') {
      bossMessage = '消耗的券已返还。';
    } else if (voucherUsed) {
      bossMessage = `消耗的券和金额 ¥${refundText} 已返还。`;
    } else {
      bossMessage = `金额 ¥${refundText} 已返还。`;
    }

    await i.editReply({
      content:
        `已撤销${actionLabel}流水 ${txId}，` +
        `老板 <@${result.audit.giverId}>：${bossMessage} ` +
        `陪玩 <@${result.audit.receiverId}>：金额 ¥${workerNetText} 已扣回。`,
      allowedMentions: {
        users: [result.audit.giverId, result.audit.receiverId],
      },
    });
  } catch (err: any) {
    const msg =
      err?.message === 'already_reverted'
        ? '该打赏已撤销过。'
        : err?.message === 'gift_not_found'
        ? '未找到对应的打赏审计记录。'
        : '撤销失败，请稍后重试。';
    await i.editReply({ content: msg });
  }
}
