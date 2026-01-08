import { Client, Message, MessageCreateOptions } from 'discord.js';
import { Prisma, PrismaClient, MemberStatus, LotteryStatus } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library.js';
import { postGiftFeed } from '../features/giftFeedHelper.js';
import { recalcAllOrdersForHost } from '../services/orderService.js';
import { addHeart } from '../services/heartService.js';
import { recordIndividualTransaction } from '../services/individualTransactionService.js';
import { giftBox_success } from '../ui/orderEmbeds.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { syncSpentRolesForMember } from '../services/spentRoleService.js';
import { PRIZE_NAMES } from '../services/lotteryService.js';
import { consumeFlowBuff, consumeSpendBuff } from '../services/buffService.js';

const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS ?? '';
const ANON_NOTIFY_CHANNEL_ID = process.env.ANON_NOTIFY_CHANNEL_ID ?? '1440888773172006962';

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);
const hasSend = (channel: unknown): channel is { send: Function } =>
  !!channel && typeof (channel as any).send === 'function';
const CAKE_GIFT_NAME = '小蛋糕';
const VOUCHER_GIFT_CONFIGS: Record<string, Array<{ prizeName: string; payRate: number }>> = {
  小蛋糕: [{ prizeName: PRIZE_NAMES.CAKE_VOUCHER, payRate: 0 }],
  棒棒糖: [{ prizeName: PRIZE_NAMES.LOLLIPOP_VOUCHER, payRate: 0 }],
  香水: [{ prizeName: PRIZE_NAMES.PERFUME_VOUCHER, payRate: 0 }],
  旋转木马: [{ prizeName: PRIZE_NAMES.CAROUSEL_VOUCHER, payRate: 0 }],
  南瓜车: [{ prizeName: PRIZE_NAMES.PUMPKIN_CAR_VOUCHER, payRate: 0 }],
  留声机: [{ prizeName: PRIZE_NAMES.PHONOGRAPH_VOUCHER, payRate: 0 }],
  一日冠: [
    { prizeName: PRIZE_NAMES.CROWN_DAY_90_VOUCHER, payRate: 0.9 },
    { prizeName: PRIZE_NAMES.CROWN_75_VOUCHER, payRate: 0.75 },
  ],
  三日冠: [{ prizeName: PRIZE_NAMES.CROWN_3DAY_90_VOUCHER, payRate: 0.9 }],
  一周冠: [{ prizeName: PRIZE_NAMES.CROWN_WEEK_90_VOUCHER, payRate: 0.9 }],
  月冠名: [{ prizeName: PRIZE_NAMES.CROWN_MONTH_90_VOUCHER, payRate: 0.9 }],
};
const REF_RATE = new Prisma.Decimal(0.01);

/** Parse: "!打赏 3/liwu @UserB @UserC" */
function parseGiftingCommand(msg: Message): { quantity: number; giftName: string; toUserIds: string[] } | null {
  const content = msg.content.trim();
  if (!content.startsWith('!打赏')) return null;

  const mentionedUsers = Array.from(msg.mentions.users.values());
  if (mentionedUsers.length === 0) return null;
  const uniqueMentionIds = Array.from(new Set(mentionedUsers.map((user) => user.id)));

  // slice out everything after "!打赏"
  let rest = content.slice('!打赏'.length).trim();

  // Remove all mentions (works for <@id> and <@!id>)
  for (const id of uniqueMentionIds) {
    const mentionRegex = new RegExp(`<@!?${id}>`, 'g');
    rest = rest.replace(mentionRegex, ' ');
  }
  rest = rest.replace(/\s+/g, ' ').trim();

  const parts = rest.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const quantity = Number(parts[0]);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  const giftName = parts.slice(1).join('/'); // allow slash in gift name after first slash
  return { quantity, giftName, toUserIds: uniqueMentionIds };
}

async function ensureMember(prisma: PrismaClient, discordUserId: string, username?: string) {
  const member = await prisma.member.upsert({
    where: { discordUserId },
    update: {},
    create: { discordUserId },
  });

  const peiwan = await prisma.pEIWAN.findUnique({ where: { discordUserId } });
  if (peiwan) {
    await prisma.member.update({
      where: { discordUserId },
      data: { status: MemberStatus.PEIWAN },
    });
  }

  return member;
}

type GiftRecord = {
  GiftName: string;
  price: Prisma.Decimal | null;
  url_link: string | null;
  rate: Prisma.Decimal | null;
};

export interface GiftTransactionResult {
  txId: string;
  giftName: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  gross: Prisma.Decimal;
  receiverRate: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  heartGain: Prisma.Decimal;
  imageUrl?: string;
}

async function grantReferralForGift(
  tx: Prisma.TransactionClient,
  params: {
    giverId: string;
    receiverId: string;
    gross: Prisma.Decimal;
    netToReceiver: Prisma.Decimal;
    txOrderId: number;
    at: Date;
  }
) {
  const { giverId, receiverId, gross, netToReceiver, txOrderId, at } = params;

  const payReferral = async ({
    referral,
    amount,
    label,
  }: {
    referral: { inviterId: string; inviteeId: string; type: 'LAOBAN' | 'PEIWAN' };
    amount: Prisma.Decimal;
    label: string;
  }) => {
    if (amount.lte(0)) return;
    try {
      await tx.referralPayout.create({
        data: {
          referralId: referral.inviteeId,
          orderId: txOrderId.toString(),
          amount,
        },
      });
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        return; // already paid for this tx
      }
      throw err;
    }

    const inviterAccount = await tx.member.upsert({
      where: { discordUserId: referral.inviterId },
      create: { discordUserId: referral.inviterId },
      update: {},
      select: { totalBalance: true },
    });

    const balanceBefore = new Prisma.Decimal(inviterAccount.totalBalance ?? 0);
    const balanceAfter = balanceBefore.add(amount);

    await tx.member.update({
      where: { discordUserId: referral.inviterId },
      data: {
        income: { increment: amount },
        totalBalance: { increment: amount },
      },
    });

    await recordIndividualTransaction(tx, {
      discordId: referral.inviterId,
      thirdPartydiscordId: referral.inviteeId,
      balanceBefore,
      amountChange: amount,
      balanceAfter,
      typeOfTransaction: `邀请提成`,
      timeCreatedAt: at,
    });
  };

  // Boss inviter: giver consumes, type=LAOBAN earns 1% of gross
  const bossRef = await tx.referral.findUnique({
    where: { inviteeId: giverId },
    select: { inviterId: true, inviteeId: true, type: true },
  });
  if (bossRef?.type === 'LAOBAN') {
    await payReferral({
      referral: { inviterId: bossRef.inviterId, inviteeId: bossRef.inviteeId, type: 'LAOBAN' },
      amount: gross.mul(REF_RATE),
      label: '打赏老板1%',
    });
  }

  // Peiwan inviter: receiver earns, type=PEIWAN earns 1% of netToReceiver
  const pwRef = await tx.referral.findUnique({
    where: { inviteeId: receiverId },
    select: { inviterId: true, inviteeId: true, type: true },
  });
  if (pwRef?.type === 'PEIWAN') {
    await payReferral({
      referral: { inviterId: pwRef.inviterId, inviteeId: pwRef.inviteeId, type: 'PEIWAN' },
      amount: netToReceiver.mul(REF_RATE),
      label: '打赏陪玩1%',
    });
  }
}

function buildPublicGiftSuccessMessage(result: GiftTransactionResult): MessageCreateOptions {
  const qtyText = result.quantity.toString();
  const grossText = result.gross.toString();
  const content = `打赏成功！${qtyText} x ${result.giftName}, 总价值：${grossText}`;
  return { content };
}

async function sendAnonGiftLog(
  client: Client,
  payload: { giverId: string; receiverId: string; giftName: string; quantity: number; gross: number }
) {
  if (!ANON_NOTIFY_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(ANON_NOTIFY_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased() && hasSend(channel)) {
      const lines = [
        '【匿名打赏】',
        `送礼人：<@${payload.giverId}> (${payload.giverId})`,
        `收礼人：<@${payload.receiverId}> (${payload.receiverId})`,
        `礼物：${payload.giftName} x ${payload.quantity}`,
        `总价：¥${payload.gross.toFixed(2)}`,
      ];
      await channel.send({ content: lines.join('\n'), allowedMentions: { parse: ['users'] } });
    }
  } catch (err) {
    console.error('[gifting] anon log send failed:', err);
  }
}

export async function performGift(
  client: Client,
  prisma: PrismaClient,
  params: {
    giverId: string;
    receiverId: string;
    giftName: string;
    anonymous?: boolean;
    quantity: number;
    giftRecord?: GiftRecord;
    giverUsername?: string;
    receiverUsername?: string;
    lotteryVoucherId?: string;
    voucherRequestId?: string;
  }
): Promise<GiftTransactionResult> {
  const {
    giverId,
    receiverId,
    giftName,
    anonymous = false,
    quantity,
    giftRecord,
    giverUsername,
    receiverUsername,
    lotteryVoucherId,
    voucherRequestId,
  } = params;

  if (giverId === receiverId) throw new Error('不能给自己打赏。');
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('数量必须大于 0。');

  const normalizedGiftName = giftName.normalize('NFKC').trim();
  const gift = giftRecord ?? await prisma.gift.findUnique({
    where: { GiftName: normalizedGiftName },
    select: { GiftName: true, price: true, url_link: true, rate: true },
  });
  if (!gift) throw new Error(`礼物不存在：${giftName}`);

  await Promise.all([
    ensureMember(prisma, giverId, giverUsername),
    ensureMember(prisma, receiverId, receiverUsername),
  ]);

  const qtyDecimal = DEC(quantity);
  const unitPrice = gift.price ? DEC(gift.price) : DEC(0);
  const gross = unitPrice.mul(qtyDecimal);
  if (gross.lte(0)) throw new Error('金额必须大于 0。');

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const [giverAccount, receiver] = await Promise.all([
      tx.member.findUnique({
        where: { discordUserId: giverId },
        select: { income: true, recharge: true, totalBalance: true },
      }),
      tx.member.findUnique({
        where: { discordUserId: receiverId },
        select: { commissionRate: true, income: true, recharge: true, totalBalance: true },
      }),
    ]);
    if (!giverAccount) throw new Error('付款方不存在。');
    if (!receiver) throw new Error('收款方不存在。');

    let receiverRate = DEC(receiver.commissionRate ?? 0);
    if (receiverRate.gt(1)) receiverRate = DEC(1);
    const feeRate = DEC(1).sub(receiverRate);
    const feeAmount = gross.mul(feeRate);
    const netAmount = gross.sub(feeAmount);
    const rateDecimal = gift.rate ? new Prisma.Decimal(gift.rate) : DEC(1);
    const heartGain = gross.mul(rateDecimal);

    const receiverPeiwan = await tx.pEIWAN.findUnique({
      where: { discordUserId: receiverId },
      select: { PEIWANID: true, totalEarn: true },
    });

    // 礼物类代金券：按最早优先，每券对应 giftName，可有多种折扣
    const voucherConfigs = VOUCHER_GIFT_CONFIGS[normalizedGiftName] ?? [];
    let voucherCount = 0;
    let voucherValue = DEC(0);
    if (voucherConfigs.length) {
      const allowedPrizeNames = voucherConfigs.map((v) => v.prizeName);
      // 如果指定了特定券（网站触发），只消耗该券
      if (lotteryVoucherId) {
        const voucher = await tx.lotteryDraw.findFirst({
          where: {
            id: lotteryVoucherId,
            userId: giverId,
            status: LotteryStatus.UNUSED,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            prize: { name: { in: allowedPrizeNames } },
          },
          select: { id: true, prize: { select: { name: true } } },
        });
        if (!voucher) {
          throw new Error('礼物券不可用或已过期。');
        }
        await tx.lotteryDraw.update({
          where: { id: voucher.id },
          data: {
            status: LotteryStatus.USED,
            consumeAt: now,
            requestId: voucherRequestId ?? undefined,
          },
        });
        voucherCount = 1;
        const cfg = voucherConfigs.find((c) => c.prizeName === voucher.prize?.name);
        const payRate = new Prisma.Decimal(cfg?.payRate ?? 1);
        const discountRate = new Prisma.Decimal(1).sub(payRate);
        voucherValue = voucherValue.add(unitPrice.mul(discountRate));
      } else {
        // 旧逻辑：按数量取最早券
        await tx.lotteryDraw.updateMany({
          where: {
            userId: giverId,
            status: LotteryStatus.UNUSED,
            expiresAt: { lte: now },
            prize: { name: { in: allowedPrizeNames } },
          },
          data: { status: LotteryStatus.EXPIRED },
        });
        const vouchers = await tx.lotteryDraw.findMany({
          where: {
            userId: giverId,
            status: LotteryStatus.UNUSED,
            expiresAt: { gt: now },
            prize: { name: { in: allowedPrizeNames } },
          },
          select: { id: true, prize: { select: { name: true } } },
          orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
          take: quantity,
        });
        voucherCount = vouchers.length;
        if (voucherCount > 0) {
          const ids = vouchers.map((v) => v.id);
          await tx.lotteryDraw.updateMany({
            where: { id: { in: ids } },
            data: { status: LotteryStatus.USED, consumeAt: now },
          });
          for (const v of vouchers) {
            const cfg = voucherConfigs.find((c) => c.prizeName === v.prize?.name);
            const payRate = new Prisma.Decimal(cfg?.payRate ?? 1);
            const discountRate = new Prisma.Decimal(1).sub(payRate);
            voucherValue = voucherValue.add(unitPrice.mul(discountRate));
          }
        }
      }
    }
    const payableRaw = gross.sub(voucherValue);
    const payable = payableRaw.lt(0) ? DEC(0) : payableRaw;

    const giverIncome = new Prisma.Decimal(giverAccount.income ?? 0);
    const giverRecharge = new Prisma.Decimal(giverAccount.recharge ?? 0);
    const giverTotal = new Prisma.Decimal(giverAccount.totalBalance ?? 0);
    if (giverTotal.lt(payable)) throw new Error('余额不足，无法完成打赏。');

    let giverSplit: ReturnType<typeof splitIncomeRecharge>;
    if (payable.lte(0)) {
      const total = giverIncome.add(giverRecharge);
      giverSplit = {
        fromIncome: DEC(0),
        fromRecharge: DEC(0),
        incomeAfter: giverIncome,
        rechargeAfter: giverRecharge,
        totalBefore: total,
        totalAfter: total,
      };
    } else {
      try {
        giverSplit = splitIncomeRecharge(giverIncome, giverRecharge, payable);
      } catch (err: any) {
        if (err?.message === 'INSUFFICIENT_FUNDS') {
          throw new Error('余额不足，无法完成打赏。');
        }
        throw err;
      }
    }

    const spendBonus = await consumeSpendBuff(tx, giverId, payable);
    const totalSpentIncrement = payable.add(spendBonus.extra);

    await tx.member.update({
      where: { discordUserId: giverId },
      data: {
        income: { decrement: giverSplit.fromIncome },
        recharge: { decrement: giverSplit.fromRecharge },
        totalBalance: { decrement: payable },
        totalSpent: { increment: totalSpentIncrement },
      },
    });

    const giverIndTx = await recordIndividualTransaction(tx, {
      discordId: giverId,
      thirdPartydiscordId: receiverId,
      balanceBefore: giverSplit.totalBefore,
      amountChange: payable,
      balanceAfter: giverSplit.totalAfter,
      typeOfTransaction: '打赏',
    });

    const receiverIncomeBefore = new Prisma.Decimal(receiver.income ?? 0);
    const receiverRechargeBefore = new Prisma.Decimal(receiver.recharge ?? 0);
    const receiverBalanceBefore = new Prisma.Decimal(receiver.totalBalance ?? 0);
    let extraFlow = DEC(0);

    await tx.member.update({
      where: { discordUserId: receiverId },
      data: {
        income: { increment: netAmount },
        totalBalance: { increment: netAmount },
        ...(receiverPeiwan ? { status: MemberStatus.PEIWAN } : {}),
      },
    });

    const receiverBalanceAfter = receiverBalanceBefore.add(netAmount);
    const receiverIncomeAfter = receiverIncomeBefore.add(netAmount);

    if (receiverPeiwan) {
      const flowBonus = await consumeFlowBuff(tx, receiverId, gross);
      extraFlow = flowBonus.extra;
      const totalEarnIncrement = gross.add(extraFlow);

      await tx.pEIWAN.update({
        where: { discordUserId: receiverId },
        data: {
          balance: receiverBalanceAfter,
          totalEarn: new Prisma.Decimal(receiverPeiwan.totalEarn ?? 0).add(totalEarnIncrement),
        },
      });
    }

    const receiverIndTx = await recordIndividualTransaction(tx, {
      discordId: receiverId,
      thirdPartydiscordId: giverId,
      balanceBefore: receiverBalanceBefore,
      amountChange: netAmount,
      balanceAfter: receiverBalanceAfter,
      typeOfTransaction: '打赏',
    });

    const txRow = await tx.transaction.create({
      data: {
        fromId: giverId,
        toId: receiverId,
        amount: gross,
        feeAmount,
        netAmount,
      },
      select: { Transid: true, orderID: true },
    });

    await tx.commission.create({
      data: {
        transactionId: txRow.Transid,
        orderID: txRow.orderID,
        fromId: giverId,
        toId: receiverId,
        feeAmount,
      },
    });

    await grantReferralForGift(tx, {
      giverId,
      receiverId,
      gross,
      netToReceiver: netAmount,
      txOrderId: txRow.orderID,
      at: now,
    });

<<<<<<< Updated upstream
=======
    const heartGainInt = Math.round(Number(heartGain.toString()));

    await tx.giftAudit.create({
      data: {
        paymentTransactionId: txRow.Transid,
        individualTransactionId: giverIndTx.transactionId,
        orderId: txRow.orderID,
        giftName: gift.GiftName,
        quantity: qtyDecimal,
        unitPrice,
        gross,
        payable,
        feeAmount,
        netAmount,
        receiverRate,
        heartGain: heartGainInt,
        giverId,
        receiverId,
        giverFromIncome: giverSplit.fromIncome,
        giverFromRecharge: giverSplit.fromRecharge,
        spendBonusExtra: spendBonus.extra,
        spendRemainingBefore,
        flowBonusExtra: extraFlow,
        flowRemainingBefore,
        voucherIds: consumedVoucherIds,
        bossReferralInviterId: referralResult.boss?.inviterId ?? null,
        bossReferralAmount: referralResult.boss?.amount ?? null,
        workerReferralInviterId: referralResult.worker?.inviterId ?? null,
        workerReferralAmount: referralResult.worker?.amount ?? null,
      },
    });

>>>>>>> Stashed changes
    return {
      txId: txRow.Transid,
      giftName: gift.GiftName,
      quantity: qtyDecimal,
      unitPrice,
      gross,
      receiverRate,
      feeAmount,
      netAmount,
      heartGain,
      imageUrl: gift.url_link ?? undefined,
    };
  });

  await addHeart(giverId, receiverId, Number(result.heartGain.toString()));
  await postGiftFeed(client, {
    giverId,
    receiverId,
    giftName: result.giftName,
    quantity: Number(result.quantity.toString()),
    totalAmount: Number(result.gross.toString()),
    imageUrl: result.imageUrl,
    anonymous,
  });
  if (anonymous) {
    await sendAnonGiftLog(client, {
      giverId,
      receiverId,
      giftName: result.giftName,
      quantity: Number(result.quantity.toString()),
      gross: Number(result.gross.toString()),
    });
  }
  await recalcAllOrdersForHost(giverId);

  try {
    const receiverUser = await client.users.fetch(receiverId);
    const giverMention = `<@${giverId}>`;
    const totalPrice = Number(result.gross.toString()).toFixed(2);
    await receiverUser.send(
      `你收到了 ${giverMention} 打赏的 ${result.quantity.toString()} 个 ${result.giftName}，总价为 ¥${totalPrice}。`
    );
  } catch (notifyErr) {
    console.error('[performGift] notify receiver failed:', notifyErr);
  }

  syncSpentRolesForMember(giverId).catch((err) =>
    console.error('[spent-role] gift sync failed', err)
  );
  syncSpentRolesForMember(receiverId, { includeSpendRoles: false }).catch((err) =>
    console.error('[spent-role] gift sync failed for receiver', err)
  );

  return result;
}

function makeStaffPing() {
  const ids = ADMIN_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  return ids.length ? ids.map((id) => `<@${id}>`).join(' ') : '客服';
}

export function registerGiftingCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg: Message) => {
    try {
      if (msg.author.bot) return;

      const content = msg.content.trim();
      const isAnon = content.startsWith('!匿名打赏');
      const isRegular = content.startsWith('!打赏');
      if (!isAnon && !isRegular) return;

      if (isAnon) {
        await prisma.interactionLog.create({
          data: {
            memberId: msg.author.id,
            command: '!匿名打赏',
            payload: { content: msg.content } as any,
          },
        });

        if (msg.guild) {
          await msg.reply('匿名打赏请私信机器人使用 `!匿名打赏 数量/礼物名 PEIWANID`。');
          return;
        }

        const rest = content.slice('!匿名打赏'.length).trim();
        if (!rest) {
          await msg.reply('用法：`!匿名打赏 数量/礼物名 PEIWANID`，例如：`!匿名打赏 1/甜甜圈 1101`。');
          return;
        }

        const tokens = rest.split(/\s+/);
        if (tokens.length < 2) {
          await msg.reply('用法：`!匿名打赏 数量/礼物名 PEIWANID`，例如：`!匿名打赏 1/甜甜圈 1101`。');
          return;
        }

        const peiwanIdStr = tokens.pop()!;
        const giftPart = tokens.join(' ');
        const peiwanId = Number(peiwanIdStr);
        if (!Number.isInteger(peiwanId) || peiwanId <= 0) {
          await msg.reply('陪玩编号无效，请输入正确的数字。');
          return;
        }

        const giftTokens = giftPart.split('/');
        if (giftTokens.length < 2) {
          await msg.reply('礼物格式无效，请使用 `数量/礼物名`。');
          return;
        }

        const quantityRaw = giftTokens.shift()!;
        const giftName = giftTokens.join('/');
        const quantity = Number(quantityRaw);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          await msg.reply('数量必须为正整数。');
          return;
        }

        const peiwan = await prisma.pEIWAN.findUnique({
          where: { PEIWANID: peiwanId },
          select: { discordUserId: true },
        });
        if (!peiwan) {
          await msg.reply(`未找到编号为 ${peiwanId} 的陪玩。`);
          return;
        }

        const receiverId = peiwan.discordUserId;
        if (receiverId === msg.author.id) {
          await msg.reply('不能给自己打赏哦。');
          return;
        }

        const receiverUser = await msg.client.users.fetch(receiverId).catch(() => null);

        const result = await performGift(msg.client, prisma, {
          giverId: msg.author.id,
          receiverId,
          giftName,
          quantity,
          anonymous: true,
          giverUsername: msg.author.username,
          receiverUsername: receiverUser?.username,
        });

        await msg.reply(
          giftBox_success(`<@${receiverId}>`, result.quantity.toString(), result.giftName)
        );
        return;
      }

      if (!isRegular) return;

      await prisma.interactionLog.create({
        data: {
          memberId: msg.author.id,
          command: '!打赏',
          payload: { content: msg.content } as any,
        },
      });

      const parsed = parseGiftingCommand(msg);
      if (!parsed) {
        await msg.reply('用法：`!打赏 数量/礼物名 @对方(可多个)` 例如：`!打赏 3/甜甜圈 @陪玩A @陪玩B`');
        return;
      }

      const giverId = msg.author.id;
      const { toUserIds, quantity, giftName } = parsed;

      if (toUserIds.some((id) => id === giverId)) {
        await msg.reply('不能给自己打赏哦。');
        return;
      }

      await Promise.all([
        ensureMember(prisma, giverId, msg.author.username),
        ...toUserIds.map((id) => ensureMember(prisma, id, msg.mentions.users.get(id)?.username)),
      ]);

      const normalized = giftName.normalize('NFKC').trim();
      const gift = await prisma.gift.findFirst({
        where: { GiftName: { contains: normalized, mode: 'insensitive' } },
        select: { GiftName: true, price: true, url_link: true, rate: true },
      });

      if (!gift) {
        const suggestions = await prisma.gift.findMany({
          where: { GiftName: { contains: normalized, mode: 'insensitive' } },
          take: 5,
          orderBy: { GiftName: 'asc' },
          select: { GiftName: true },
        });
        const hint = suggestions.length
          ? `可选：${suggestions.map((s) => s.GiftName).join(', ')}`
          : '（没有相近名称）';
        await msg.reply(`礼物不存在：${giftName}。${hint}`);
        return;
      }

      const results: { receiverId: string; result: GiftTransactionResult }[] = [];
      for (const receiverId of toUserIds) {
        const receiverUsername = msg.mentions.users.get(receiverId)?.username;
        const result = await performGift(msg.client, prisma, {
          giverId,
          receiverId,
          giftName: gift.GiftName,
          anonymous: false,
          quantity,
          giftRecord: gift,
          giverUsername: msg.author.username,
          receiverUsername: receiverUsername,
        });
        results.push({ receiverId, result });
      }

      const channel: any = msg.channel;
      for (const { receiverId, result } of results) {
        const successPayload = buildPublicGiftSuccessMessage(result);
        const mentionPrefix = `<@${receiverId}> `;
        const baseContent = successPayload.content ?? '';
        successPayload.content = `${baseContent}`.trim();
        if (channel && typeof channel.send === 'function') {
          await channel.send(successPayload);
          if (result.imageUrl) {
            await channel.send(result.imageUrl);
          }
        } else {
          await msg.reply(successPayload);
          if (result.imageUrl) {
            await msg.reply(result.imageUrl);
          }
        }
      }
    } catch (err: any) {
      console.error('[gifting] error:', err);
      const plainMessage = err?.message ?? '未知错误';
      const insufficient =
        typeof plainMessage === 'string' && plainMessage.includes('余额不足，无法完成打赏。');
      try {
        const replyText = insufficient ? '打赏失败：请查看私信噢' : `打赏失败：${plainMessage}`;
        await msg.reply(replyText);
      } catch {}
      if (insufficient) {
        const staffPing = makeStaffPing();
        try {
          await msg.author.send(`打赏失败：余额不足，请联系 ${staffPing} 进行充值后再试。`);
        } catch (dmErr) {
          console.error('[gifting] notify insufficient balance DM failed:', dmErr);
        }
      }
    }
  });
}
