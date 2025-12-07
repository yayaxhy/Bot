import { Prisma } from '@prisma/client';
import { StringSelectMenuInteraction } from 'discord.js';
import { applyDiscountForOrder, DiscountKind } from '../../services/discountService.js';

export async function handleDiscountSelect(i: StringSelectMenuInteraction) {
  if (!i.customId.startsWith('discount_box')) return;

  const [, orderId] = i.customId.split(':');
  const choice = i.values[0];

  if (!orderId || !choice) {
    await i.reply({ content: '无效的选项。' });
    return;
  }

  const kind: DiscountKind | null =
    choice === 'jiuzhe' ? 'coupon' : choice === 'bazhe' ? 'lottery' : null;
  const label = kind === 'coupon' ? '9折券' : kind === 'lottery' ? '8折券' : '';

  if (!kind) {
    await i.reply({ content: '当前暂不支持该优惠券。' });
    return;
  }

  await i.deferUpdate();
  const result = await applyDiscountForOrder({
    orderId,
    userId: i.user.id,
    kind,
  });

  const reply = (content: string) =>
    i.followUp({
      content,
    });

  if (result.status !== 'applied') {
    switch (result.status) {
      case 'order_not_found':
        await reply('未找到对应订单。');
        break;
      case 'not_order_host':
        await reply('只有该订单的老板可以使用优惠券。');
        break;
      case 'order_not_ended':
        await reply('订单尚未结单，暂无法使用优惠券。');
        break;
      case 'already_used':
        await reply('该订单已使用过优惠券。');
        break;
      case 'no_coupon':
        await reply('没有可用的九折券。');
        break;
      case 'no_lottery':
        await reply('没有可用的 8 折券。');
        break;
      case 'no_fee':
      case 'insufficient_data':
      default:
        await reply('该订单未产生费用，无法使用优惠券。');
        break;
    }
    return;
  }

  const amount = new Prisma.Decimal(result.discountAmount ?? 0);
  await i.editReply({ components: [] });
  await i.followUp({
    content: `已使用 ${label}，本单返还 ¥${amount.toFixed(2)}，金额已入账。`,
  });
}
