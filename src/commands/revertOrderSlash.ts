import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { revertOrderByOrderId } from '../services/revertOrderService.js';
import { isCashAdmin } from './cash.js';

export const revertOrderCommand = new SlashCommandBuilder()
  .setName('撤回订单')
  .setDescription('根据订单号撤销一笔订单（仅客服/管理员可用）')
  .addStringOption((opt) =>
    opt
      .setName('order_id')
      .setDescription('Order.id（c...）或订单展示编号（纯数字）')
      .setRequired(true),
  )
  .addStringOption((opt) => opt.setName('reason').setDescription('撤销原因').setRequired(false));

export async function handleRevertOrderSlash(i: ChatInputCommandInteraction) {
  if (!isCashAdmin(i)) {
    await i.reply({ content: '❌ 你没有权限执行撤销。', ephemeral: true });
    return;
  }

  await i.deferReply({ ephemeral: false }).catch(() => {});

  const orderId = i.options.getString('order_id', true).trim();
  const reason = i.options.getString('reason') ?? undefined;

  try {
    const ret = await revertOrderByOrderId({
      orderId,
      operatorId: i.user.id,
      reason,
    });
    const orderLabel = ret.order?.displayNo ?? ret.order?.id ?? orderId;
    await i.editReply({ content: `已撤销订单 ${orderLabel}，请留意余额和通知。` });
  } catch (err: any) {
    const msg =
      err?.message === 'already_reverted'
        ? '该订单已撤销过。'
        : err?.message === 'order_not_found'
        ? '未找到对应订单。'
        : err?.message === 'order_audit_not_found'
        ? '该订单没有审计快照，无法撤销。'
        : err?.message === 'order_not_ended'
        ? '该订单不是已结束状态，暂不可撤销。'
        : err?.message === 'order_amount_empty'
        ? '该订单金额为 0，可能已撤销或未结算。'
        : '撤销失败，请稍后重试。';
    await i.editReply({ content: msg });
  }
}
