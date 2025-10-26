import { Client, GuildMember, Message } from "discord.js";
import { Prisma, PrismaClient } from "@prisma/client";

const DEC = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

function isCashAdmin(msg: Message) {
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

async function ensureMember(prisma: PrismaClient, discordUserId: string) {
  // If your Member model has required fields without defaults, add them here.
  return prisma.member.upsert({
    where: { discordUserId },
    update: {},
    create: { discordUserId },
  });
}

export function registerCashCommand(client: Client, prisma: PrismaClient) {
  client.on("messageCreate", async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.content.toLowerCase().startsWith("!cash")) return;

      // permissions
      if (!isCashAdmin(msg)) {
        await msg.reply("❌ 你没有权限使用该命令。");
        return;
      }

      // log the call
      await prisma.interactionLog.create({
        data: {
          memberId: msg.author.id,
          command: "!cash",
          payload: { content: msg.content } as any, // make sure payload is Json in Prisma
        },
      });

      // parse
      const parsed = parseCashCommand(msg);
      if (!parsed) {
        await msg.reply("用法：`!cash +金额 @用户` 或 `!cash -金额 @用户`，例如：`!cash +100 @Alice`");
        return;
      }

      const { sign, amount, targetId } = parsed;

      // make sure member exists
      await ensureMember(prisma, targetId);

      if (sign === "+") {
        // increment balance
        const updated = await prisma.member.update({
          where: { discordUserId: targetId },
          data: { balance: { increment: amount } },
          select: { balance: true, discordUserId: true },
        });

        await msg.reply(`✅ 已为 <@${targetId}> 增加余额 **${amount.toString()}**。当前余额：**${updated.balance.toString()}**`);
      } else {
        // decrement with non-negative guard
        const updatedCount = await prisma.member.updateMany({
          where: {
            discordUserId: targetId,
            balance: { gte: amount },   // guard: cannot go below zero
          },
          data: { balance: { decrement: amount } },
        });

        if (updatedCount.count === 0) {
          await msg.reply(`❌ 扣减失败。原因：余额不足或用户不存在。`);
          return;
        }

        const after = await prisma.member.findUnique({
          where: { discordUserId: targetId },
          select: { balance: true },
        });

        await msg.channel.send(`✅ 已为 <@${targetId}> 扣减余额 **${amount.toString()}**。当前余额：**${after?.balance.toString()}**`);
      }
    } catch (err: any) {
      console.error("[cash] error:", err);
      try { await msg.reply(`❌ 操作失败：${err?.message ?? "未知错误"}`); } catch {}
    }
  });
}
