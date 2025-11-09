import { Client, GuildMember, Message } from "discord.js";
import { Prisma, PrismaClient, MemberStatus } from "@prisma/client";
import { recordIndividualTransaction } from "../services/individualTransactionService.js";
import { splitIncomeRecharge } from "../lib/balanceMath.js";

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

// Check if the user is an admin (able to use !cash and allow negative balance)
export function isCashAdmin(msg: Message) {
  const allowedUsers = (process.env.CASH_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (allowedUsers.length && allowedUsers.includes(msg.author.id)) return true;

  // role check (guild only)
  const roleId = process.env.CASH_ALLOWED_ROLE_ID;
  if (roleId && msg.inGuild()) {
    const m = msg.member as GuildMember | null;
    if (m?.roles.cache.has(roleId)) return true;
  }
  return false;
}

/** Parse: "!cash +123.45 @UserA" or "!cash -50 @UserA"
 *  Returns { sign: "+"|"-", amount: Decimal, targetId: string }
 */
function parseCashCommand(msg: Message): { sign: "+" | "-", amount: Prisma.Decimal; targetId: string } | null {
  const content = msg.content.trim();
  if (!content.toLowerCase().startsWith("!cash")) return null;

  const target = msg.mentions.users.first();
  if (!target) return null;

  // text after "!cash"
  let rest = content.slice("!cash".length).trim();

  // strip the mention (<@id> or <@!id>)
  const mentionRegex = new RegExp(`<@!?${target.id}>`, "g");
  rest = rest.replace(mentionRegex, "").trim();

  // expect something like "+123.45" or "-50"
  const m = rest.match(/^([+-])\s*([0-9]+(?:\.[0-9]{1,4})?)$/);
  if (!m) return null;

  const sign = m[1] as "+" | "-";
  const amount = DEC(m[2]);
  if (amount.lte(0)) return null;

  return { sign, amount, targetId: target.id };
}

async function recordRecharge(
  prisma: PrismaClient,
  amount: Prisma.Decimal,
  toWhom: string,
  fromWhom: string
) {
  await prisma.$transaction(async (tx) => {
    const latest = await tx.recharge.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { RechargeID: true },
    });
    let nextNumber = 1;
    if (latest?.RechargeID) {
      const match = latest.RechargeID.match(/^C(\d+)$/i);
      if (match) {
        nextNumber = Number(match[1]) + 1;
      }
    }
    const RechargeID = `C${nextNumber}`;
    await tx.recharge.create({
      data: {
        RechargeID,
        amount,
        toWhom,
        fromWhom,
      },
    });
  });
}

export function registerCashCommand(client: Client, prisma: PrismaClient) {
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.content.toLowerCase().startsWith("!cash")) return;

      // permissions
      if (!isCashAdmin(msg)) {
        await msg.reply("❌ 你没有权限使用该命令。");
        return;
      }

      // parse
      const parsed = parseCashCommand(msg);
      if (!parsed) {
        await msg.reply("用法：`!cash +金额 @用户` 或 `!cash -金额 @用户`");
        return;
      }

      const { sign, amount, targetId } = parsed;

      // Make sure the member exists
      await prisma.member.upsert({
        where: { discordUserId: targetId },
        create: { discordUserId: targetId },
        update: {},
      });

      const peiwanRecord = await prisma.pEIWAN.findUnique({
        where: { discordUserId: targetId },
        select: { PEIWANID: true },
      });

      if (sign === "+") {
        const txResult = await prisma.$transaction(async (tx) => {
          const updated = await tx.member.update({
            where: { discordUserId: targetId },
            data: {
              recharge: { increment: amount },
              totalBalance: { increment: amount },
              ...(peiwanRecord ? { status: MemberStatus.PEIWAN } : {}),
            },
            select: { totalBalance: true },
          });

          if (peiwanRecord) {
            await tx.pEIWAN.update({
              where: { discordUserId: targetId },
              data: { balance: updated.totalBalance },
            });
          }

          const balanceAfter = new Prisma.Decimal(updated.totalBalance ?? 0);
          const balanceBefore = balanceAfter.sub(amount);

          await recordIndividualTransaction(tx, {
            discordId: targetId,
            thirdPartydiscordId: msg.author.id,
            balanceBefore,
            amountChange: amount,
            balanceAfter,
            typeOfTransaction: '充值',
          });

          return { balance: balanceAfter };
        });

        await recordRecharge(prisma, amount, targetId, msg.author.id);

        await msg.channel.send(` 已为 <@${targetId}> 增加余额 **${amount.toString()}**。当前余额：**${txResult.balance.toString()}**`);

        try {
          const targetUser = await client.users.fetch(targetId);
          await targetUser.send(
            `已为您增加余额 **${amount.toString()}**。当前余额：**${txResult.balance.toString()}**`
          );
        } catch (notifyErr) {
          console.error('[cash] notify recharge DM failed:', notifyErr);
        }
      } else {
        const insufficientFlag = 'INSUFFICIENT_BALANCE';
        const isAdmin = await isCashAdmin(msg);

        try {
          const txResult = await prisma.$transaction(async (tx) => {
            const member = await tx.member.findUnique({
              where: { discordUserId: targetId },
              select: { income: true, recharge: true, totalBalance: true },
            });
            if (!member) throw new Error('TARGET_NOT_FOUND');

            const incomeBefore = new Prisma.Decimal(member.income ?? 0);
            const rechargeBefore = new Prisma.Decimal(member.recharge ?? 0);
            const totalBefore = new Prisma.Decimal(member.totalBalance ?? 0);

            if (!isAdmin && totalBefore.lt(amount)) {
              throw new Error(insufficientFlag);
            }

            let incomeDecrement: Prisma.Decimal;
            let rechargeDecrement: Prisma.Decimal;
            if (totalBefore.lt(amount)) {
              const possibleIncome = incomeBefore.gte(amount) ? amount : incomeBefore;
              incomeDecrement = possibleIncome;
              rechargeDecrement = amount.sub(possibleIncome);
            } else {
              const split = splitIncomeRecharge(incomeBefore, rechargeBefore, amount);
              incomeDecrement = split.fromIncome;
              rechargeDecrement = split.fromRecharge;
            }

            const updated = await tx.member.update({
              where: { discordUserId: targetId },
              data: {
                income: { decrement: incomeDecrement },
                recharge: { decrement: rechargeDecrement },
                totalBalance: { decrement: amount },
              },
              select: { totalBalance: true },
            });

            if (peiwanRecord) {
              await tx.pEIWAN.update({
                where: { discordUserId: targetId },
                data: { balance: updated.totalBalance },
              });
            }

            const balanceAfter = new Prisma.Decimal(updated.totalBalance ?? 0);
            const balanceBefore = balanceAfter.add(amount);

            await recordIndividualTransaction(tx, {
              discordId: targetId,
              thirdPartydiscordId: msg.author.id,
              balanceBefore,
              amountChange: amount,
              balanceAfter,
              typeOfTransaction: '扣款',
            });

            return { balance: balanceAfter };
          });

          await recordRecharge(prisma, amount.mul(-1), targetId, msg.author.id);
          await msg.channel.send(`已为 <@${targetId}> 扣减余额 **${amount.toString()}**。当前余额：**${txResult.balance.toString()}**`);
        } catch (err: any) {
          if (err?.message === insufficientFlag) {
            await msg.reply(`❌ 扣减失败。原因：余额不足，无法扣除。`);
            return;
          }
          throw err;
        }
      }
    } catch (err: any) {
      console.error("[cash] error:", err);
      try { await msg.reply(`❌ 操作失败：${err?.message ?? "未知错误"}`); } catch {}
    }
  });
}
