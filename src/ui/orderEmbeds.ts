// src/ui/orderEmbeds.ts
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  APIEmbed, EmbedBuilder, MessageCreateOptions
} from 'discord.js';
import { QuotationCode, Gift } from '@prisma/client';

const ORDER_ID_PREFIX = process.env.ORDER_ID_PREFIX ?? '';
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS ?? '';
const THANK_BOSS_GIF_PATH = 'src/img/thankBoss.gif';
const ORDER_PIC_PATH = 'src/img/orderPic.gif';
const DEFAULT_EMBED_COLOR = 0xf5a623;

const ROLE_KEYWORDS_TO_IDS: Record<string, string> = {
  '@女陪陪': '1430923008045744211',
  '@男陪陪': '1430923554852962406',
  '@技术陪陪': '1430923746830581841',
};

const ROLE_ID_TO_TEXT: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_KEYWORDS_TO_IDS).map(([text, id]) => [id, text])
);

export function parseRoleMentions(raw: string): { mentionText: string; plainText: string; roleIds: string[] } {
  const source = raw ?? '';
  if (!source.trim()) return { mentionText: '', plainText: '', roleIds: [] };

  let formatted = source;
  const roleIds = new Set<string>();

  for (const [keyword, roleId] of Object.entries(ROLE_KEYWORDS_TO_IDS)) {
    if (formatted.includes(keyword)) {
      const mention = `<@&${roleId}>`;
      formatted = formatted.split(keyword).join(mention);
      roleIds.add(roleId);
    }
  }

  const explicitMentions = formatted.match(/<@&(\d+)>/g) ?? [];
  for (const mention of explicitMentions) {
    const id = mention.slice(3, -1);
    if (id) roleIds.add(id);
  }

  const mentionText = formatted.trim();
  const plainText = mentionText.replace(/<@&(\d+)>/g, (_, id: string) => ROLE_ID_TO_TEXT[id] ?? '').trim();

  return { mentionText, plainText, roleIds: [...roleIds] };
}

function stripRoleMentions(text: string): string {
  return text
    .replace(/<@&\d+>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function getAdminMentions(): string {
  const ids = ADMIN_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return '<@1421651539247894549>';
  return ids.map((id) => `<@${id}>`).join(' ');
}

function base(title: string, desc?: string): APIEmbed {
  const e = new EmbedBuilder().setTitle(title).setColor(DEFAULT_EMBED_COLOR);
  if (desc) e.setDescription(desc);
  return e.toJSON();
}

const clickCounts = new Map<string, number>(); // Stores the count of button clicks per order

// Function to increase the count when a button is clicked
export function increaseClickCount(orderId: string) {
  const currentCount = clickCounts.get(orderId) || 0;
  clickCounts.set(orderId, currentCount + 1);
}

// Function to get the current count of clicks
export function getClickCount(orderId: string) {
  return clickCounts.get(orderId) || 0;
}

/* ================== 派单（公开） ================== */
export function ongoing_order_request_embed(
  authorTag: string,
  rolesLine: string,
  originalMsg: string,
  orderId: string,
  ownerId: string
): MessageCreateOptions {
  const { plainText: mentionPlain } = parseRoleMentions(rolesLine);
  const mentionLinePlain = mentionPlain.trim();

  const lines = [
    '正在派单 呼叫陪陪啦',
    '',
    `⭐ ${authorTag}：正在呼叫陪陪`,
    '',
  ];
  if (mentionLinePlain) lines.push(`⭐ ${mentionLinePlain}`);

  const embed = new EmbedBuilder()
    .setTitle('派单进行中')
    .setColor(DEFAULT_EMBED_COLOR)
    .setDescription(lines.join('\n'))
    .setImage('attachment://orderPic.gif');

  const button = new ButtonBuilder()
    .setCustomId(`requestOrder:${orderId}:${ownerId}`)
    .setLabel(`抢单 (${getClickCount(orderId)})`)
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  const attachment = new AttachmentBuilder(ORDER_PIC_PATH).setName('orderPic.gif');

  return { embeds: [embed], components: [row], files: [attachment] };
}

/* ================== 派单（匿名老板） ================== */
export function anonymous_ongoing_order_request_embed(
  rolesLine: string,
  originalMsg: string,
  orderId: string,
  ownerId: string
): MessageCreateOptions {
  const { plainText: mentionPlain } = parseRoleMentions(rolesLine);
  const mentionLinePlain = mentionPlain.trim();

  const lines = [
    '【正在派单】 呼叫陪陪啦',
    '',
    '匿名老板：正在呼叫陪陪',
    '',
  ];
  if (mentionLinePlain) lines.push(`⭐ ${mentionLinePlain}`);
  const embed = new EmbedBuilder()
    .setTitle('派单进行中')
    .setColor(DEFAULT_EMBED_COLOR)
    .setDescription(lines.join('\n'))
    .setImage('attachment://orderPic.gif');

  const button = new ButtonBuilder()
    .setCustomId(`requestOrder:${orderId}:${ownerId}`)
    .setLabel(`抢单 (${getClickCount(orderId)})`)
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  const attachment = new AttachmentBuilder(ORDER_PIC_PATH).setName('orderPic.gif');

  return { embeds: [embed], components: [row], files: [attachment] };
}

/* ================== 订单创建成功（DM 给老板） ================== */
export function order_request_sent_successfully_embed(interId: string): {
  embed: APIEmbed; components: any[];
} {
  const lines = [
    '## 💕【订单已创建】正在火速派单中！',
    '',
    `✨\`订单号\`：\`${interId}\``,
    '',
    '✨以下陪陪已对该订单发起抢单，祝板板挑选到心仪的陪陪！',
    '',
    '✨温馨提示：请板板确认余额充足，余额不足时会自动结单哦',
    '',
    `✨锦鲤客服随时在线为您服务 ${getAdminMentions()}`,
  ];
  const embed = base('订单创建', lines.join('\n'));

  const cancel = new ButtonBuilder()
    .setCustomId('order_cancel')
    .setLabel('取消派单')
    .setStyle(ButtonStyle.Danger);

  return { embed, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(cancel)] };
}

/* ================== MP 卡（DM 给老板） ================== */
/** 注意：四个下拉都允许为 null；我们只渲染存在的下拉，避免 0 选项导致 50035 */
export function sent_MP_embed(
  isTech: boolean,
  peiwanId: number,
  workerMention: string,
  orderContent: string,
  mpUrl: string | null,
  realnameBox: StringSelectMenuBuilder | null,
  anonymousBox: StringSelectMenuBuilder | null,
  realnameGiftBox: StringSelectMenuBuilder | null,
  anonymousGiftBox: StringSelectMenuBuilder | null
): { embed: APIEmbed; components: any[] } {
  const sanitizedOrderContent = stripRoleMentions(String(orderContent ?? '')).slice(0, 1024);

  const e = new EmbedBuilder()
    .setTitle(isTech ? '技术陪玩' : '娱乐陪玩')
    .addFields({ name: '陪玩ID', value: `${peiwanId} ${workerMention}`, inline: true })
    .setColor(DEFAULT_EMBED_COLOR);

  if (sanitizedOrderContent) {
    e.addFields({ name: '订单内容', value: sanitizedOrderContent, inline: false });
  }

  if (mpUrl) e.setImage(mpUrl);

  const rows: any[] = [];
  if (realnameBox)      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(realnameBox));
  if (anonymousBox)     rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(anonymousBox));
  if (realnameGiftBox)  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(realnameGiftBox));
  if (anonymousGiftBox) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(anonymousGiftBox));

  return { embed: e.toJSON(), components: rows };
}

/* ================== 下拉框构建 ================== */
/**
 * 报价档位下拉（隐藏 null/无效）。若 0 个选项则返回 null，调用处不发该下拉。
 * 用更宽松的 Record<string, number|null|undefined> 以兼容你当前的 Q1..Q7 / DEFAULT 差异。
 */
export function buildQuotationSelect(
  kind: 'REALNAME' | 'ANON',
  prices: Record<string, number | null | undefined>
): StringSelectMenuBuilder | null {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(kind === 'REALNAME' ? 'realname_box' : 'anonymous_box')
    .setPlaceholder(kind === 'REALNAME' ? '实名点单' : '匿名点单')
    .setMinValues(1).setMaxValues(1);

  // 支持两种枚举写法：Q1..Q7 或 DEFAULT/Q2..Q7
  const labelMap: Record<string, string> = {
    Q1: '默认单价',
    Q2: 'LoL单价',
    Q3: 'Val单价',
    Q4: 'Q4单价',
    Q5: 'Q5单价',
    Q6: 'Q6单价',
    Q7: 'Q7单价',
    DEFAULT: '默认单价',
  };

  let count = 0;
  for (const code of Object.keys(labelMap)) {
    const v = prices[code];
    if (v != null && Number.isFinite(v as number)) {
      menu.addOptions({
        label: `${labelMap[code]}：¥${Number(v).toFixed(2)}`,
        value: code, // value 使用 code，长度安全，利于后续处理
      });
      count++;
      if (count >= 25) break; // Discord 限制：最多 25
    }
  }

  if (count === 0) return null; // 0 项则让调用方跳过这个下拉

  return menu;
}

/**
 * 打赏礼物下拉。若传入 gifts 为空则返回 null。
 * value 使用礼物名（1~100 长度），避免价格重复冲突；最多 25 个。
 */
export function buildGiftingSelect(
  kind: 'REALNAME' | 'ANON',
  gifts: Gift[] | Array<{ GiftName: string; price: number }>
): StringSelectMenuBuilder | null {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(kind === 'REALNAME' ? 'realname_gifting_box' : 'anonymous_gifting_box')
    .setPlaceholder(kind === 'REALNAME' ? '实名打赏' : '匿名打赏')
    .setMinValues(1).setMaxValues(1);

  let count = 0;
  for (const g of gifts as any[]) {
    const name = String(g.GiftName ?? '').trim();
    const price = Number(g.price);
    if (!name) continue;

    menu.addOptions({
      label: `${name}：¥${Number.isFinite(price) ? price.toFixed(2) : '—'}`,
      value: name, // 使用礼物名作为 value，避免与价格相关的长度/重复问题
    });
    count++;
    if (count >= 25) break; // Discord 限制：最多 25
  }

  if (count === 0) return null;

  return menu;
}

/* ================== 邀请与结束类 embed（保持不变） ================== */
export function invitation_embed(
  orderId: string,
  displayNo: number | null | undefined,
  hostDiscordId: string | null,
  gameContent: string
): {
  embed: APIEmbed, components: any[]
} {
  const bossMention = hostDiscordId ? `<@${hostDiscordId}>` : '@老板';
  const orderLabel = displayNo != null
    ? `${ORDER_ID_PREFIX}${displayNo}`
    : `${ORDER_ID_PREFIX}${orderId}`;
  const sanitizedContent = stripRoleMentions(String(gameContent ?? '')) || '请与老板取得联系并开始服务';
  const limitedContent = sanitizedContent.slice(0, 1024);
  const lines = [
    `【收到板板${bossMention} 的游玩邀请】`,
    '请接单',
    `订单号：${orderLabel}`,
    `游戏内容：${limitedContent}`,
  ];
  const embed = base('游玩邀请', lines.join('\n'));

  const accept = new ButtonBuilder()
    .setCustomId(`invite:accept:${orderId}`)
    .setLabel('接受')
    .setStyle(ButtonStyle.Success);
  const decline = new ButtonBuilder()
    .setCustomId(`invite:decline:${orderId}`)
    .setLabel('拒绝')
    .setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(accept, decline);

  return { embed, components: [row] };
}

export function giftBox_success(
  workerMention: string,
  quantity: string | number,
  giftName: string
): MessageCreateOptions {
  const qtyText = typeof quantity === 'number' ? quantity.toString() : quantity;
  const lines = [
    '【成功打赏】',
    '',
    `感谢板板对陪玩${workerMention}赠送的${qtyText}个${giftName}`,
    '祝板板天天开心！',
  ];

  const embed = new EmbedBuilder()
    .setDescription(lines.join('\n'))
    .setColor(DEFAULT_EMBED_COLOR)
    .setThumbnail('attachment://thankBoss.gif');

  const attachment = new AttachmentBuilder(THANK_BOSS_GIF_PATH).setName('thankBoss.gif');

  return {
    embeds: [embed],
    files: [attachment],
  };
}

export const PW_accept_embed = (
  orderId: string,
  displayNo: number | null | undefined,
  hostDiscordId?: string | null
) => {
  const orderLabel = displayNo != null
    ? `${ORDER_ID_PREFIX}${displayNo}`
    : `${ORDER_ID_PREFIX}${orderId}`;
  const bossMention = hostDiscordId ? `<@${hostDiscordId}>` : '@老板';

  const embed = base('接单成功', [
    '【接单成功】',
    `您已接受老板${bossMention} 的订单，系统将在5分钟后开始计费！`,
    `订单号：${orderLabel}`,
    '接单过程中您可以随时使用口令 **!陪玩结单** / **!老板结单** 或下方结单按钮结束订单，祝您游戏愉快',
  ].join('\n'));

  const endButton = new ButtonBuilder()
    .setCustomId(`order:end:${orderId}`)
    .setLabel('结单')
    .setStyle(ButtonStyle.Danger);

  return { embed, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(endButton)] };
};

export const PW_decline_embed = (hostDiscordId?: string) => {
  const bossMention = hostDiscordId ? `<@${hostDiscordId}>` : '@老板';

  return base('拒绝接单', [
    '【拒绝接单】',
    `您已拒绝老板${bossMention}的订单`,
    '如有特殊情况，请私信老板道歉并合理说明拒绝理由',
    '不得在未提前报备的情况下擅自拒绝接单哦',
  ].join('\n'));
};

export function invite_success_boss_embed(orderId: string, displayNo: number, peiwanId: number, workerMention: string): {
  embed: APIEmbed; components: any[];
} {
  const lines = [
    `您已邀请了陪玩 *${peiwanId}* ${workerMention}`,
    `订单号：${ORDER_ID_PREFIX}${displayNo}`,
    '陪陪已接单，正在火速赶来！',
    '🪙计费标准：5分钟后开始计费',
    '若需提前结束，可点击下方“结单”按钮或使用口令 !陪玩结单 / !老板结单',
  ];
  const embed = base('点单成功', lines.join('\n\n'));

  const endButton = new ButtonBuilder()
    .setCustomId(`order:end:${orderId}`)
    .setLabel('结单')
    .setStyle(ButtonStyle.Danger);

  return { embed, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(endButton)] };
}

export function order_end_boss_embed(
  orderIdentifier: number | string,
  workerDiscordId: string | null,
  peiwanId: number | string,
  totalMin: number,
  total: number,
  totalBalance: number,
  heartInc: number,
  heartTotal: number
) {
  const orderLabel = typeof orderIdentifier === 'number'
    ? `${ORDER_ID_PREFIX}${orderIdentifier}`
    : `${ORDER_ID_PREFIX}${orderIdentifier}`;
  const workerMention = workerDiscordId ? `<@${workerDiscordId}>` : '该陪玩';
  return base('订单已结束', [
    `【您与陪玩${workerMention}的订单已结束】`,
    '',
    `订单号：${orderLabel}`,
    `陪玩ID：${peiwanId}`,
    '',
    `游玩总时长：${totalMin} 分钟`,
    `总计消费：¥${total.toFixed(2)}`,
    `余额：¥${totalBalance.toFixed(2)}`,
    `心动值累计：+${heartInc}`,
    `总心动值：${heartTotal}`,
  ].join('\n'));
}

export function order_end_pw_embed(
  orderIdentifier: number | string,
  hostDiscordId: string | null,
  totalMin: number,
  gross: number,
  net: number,
  heartInc: number,
  currentHeart: number
) {
  const orderLabel = typeof orderIdentifier === 'number'
    ? `${ORDER_ID_PREFIX}${orderIdentifier}`
    : `${ORDER_ID_PREFIX}${orderIdentifier}`;
  const hostMention = hostDiscordId ? `<@${hostDiscordId}>` : '老板';
  return base('订单已结束', [
    '【订单已结束】',
    `您与老板${hostMention}的订单已结束`,
    `订单号：${orderLabel}`,
    `订单时长：${totalMin} 分钟`,
    `订单总价：¥${gross.toFixed(2)}`,
    `实际到账：¥${net.toFixed(2)}`,
    `心动值累计：+${heartInc}`,
    `当前心动值：${currentHeart}`,
  ].join('\n'));
}

export function refuse_order_request_embed(
  peiwanId: number,
  orderIdentifier: number | string,
  workerMention: string
) {
  const orderLabel = typeof orderIdentifier === 'number'
    ? `${ORDER_ID_PREFIX}${orderIdentifier}`
    : `${ORDER_ID_PREFIX}${orderIdentifier}`;
  const staffMention = `客服 ${getAdminMentions()}`;
  const workerPart = workerMention ? ` ${workerMention}` : '';

  return base('订单提醒', [
    '',
    `🙏很抱歉老板，该陪陪（${peiwanId}${workerPart}）暂时无法接单（订单号：${orderLabel}），可以继续点单其他陪玩`,
    '',
    `若您需要帮助或者了解原因，可以私信${staffMention}，我们会第一时间为您处理`,
  ].join('\n'));
}

export function invite_successfully_inDiscord_embed(bossTag: string, workerTag: string): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle('点单成功')
    .setColor(DEFAULT_EMBED_COLOR)
    .setThumbnail('attachment://thankBoss.gif')
    .setDescription([
      `老板 ${bossTag} 已点单陪玩 ${workerTag}`,
      '',
      '💕祝老板玩的开心，期待下次相遇💕',
    ].join('\n'));
  const attachment = new AttachmentBuilder(THANK_BOSS_GIF_PATH).setName('thankBoss.gif');

  return { embeds: [embed], files: [attachment] };
}

export function anon_invite_successfully_inDiscord_embed(workerTag: string): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle('点单成功')
    .setColor(DEFAULT_EMBED_COLOR)
    .setThumbnail('attachment://thankBoss.gif')
    .setDescription([
      `匿名老板已点单陪玩 ${workerTag}`,
      '',
      '💕祝老板玩的开心，期待下次相遇💕',
    ].join('\n'));
  const attachment = new AttachmentBuilder(THANK_BOSS_GIF_PATH).setName('thankBoss.gif');

  return { embeds: [embed], files: [attachment] };
}


