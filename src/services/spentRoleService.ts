import prisma from '../db/prisma.js';
import { EmbedBuilder, userMention, type Client, type Guild } from 'discord.js';
import {
  getHighestVipTierByTotalSpent,
  listOneTimeAutoBenefitsForLevel,
  VIP_TIERS,
  type VipTierConfig,
} from '../config/vipCatalog.js';
import { reconcileVipBenefitsForMember, sendVipBenefitOverviewDm } from './vipBenefitService.js';

type Tier = { threshold: number; roles: string[] };
type SpendRoleTier = VipTierConfig;
export type SyncSpentRoleOptions = {
  includeSpendRoles?: boolean;
  announceVipUpgrade?: boolean;
};

const SPENT_ROLE_GUILD_ID = process.env.SPENT_ROLE_GUILD_ID ?? '';
const VIP_UPGRADE_ANNOUNCE_CHANNEL_ID =
  process.env.VIP_UPGRADE_ANNOUNCE_CHANNEL_ID ?? '1488737027582201998';
const VIP_BENEFIT_FAILURE_CHANNEL_ID =
  process.env.VIP_BENEFIT_FAILURE_CHANNEL_ID ?? '1446819752692416542';
const VIP_BENEFIT_FAILURE_NOTIFY_USER_ID =
  process.env.VIP_BENEFIT_FAILURE_NOTIFY_USER_ID ?? '1421651539247894549';
const spentRoleSyncQueue = new Map<string, Promise<void>>();
const EMOJI_YELLOW_HANGING_STARS = '<a:229185yellowhangingstars:1443533883764375562>';
const EMOJI_BABY_PINK_SPARKLIES = '<a:995647babypinksparklies:1443519291583369266>';
const EMOJI_PINK_SPARKLES = '<a:64382pinksparkles:1445301278040391800>';
const EMOJI_HEART_POP = '<a:604354heartpop:1452472977169060032>';
const EMOJI_WHITE_PAW_BOUNCE = '<a:64382whitepawbounce:1443540848548646912>';
const EMOJI_C = '<a:AC:1422295050678833172>';
const EMOJI_O = '<a:AO:1422295368426848256>';
const EMOJI_N = '<a:AN:1422295344292827329>';
const EMOJI_G = '<a:AG:1422295140218966107>';
const EMOJI_R = '<a:AR:1422295495954403440>';
const EMOJI_A = '<a:AA:1422295004868775936>';
const EMOJI_T = '<a:AT:1422295552267386940>';
const EMOJI_U = '<a:AU:1422295584034918470>';
const EMOJI_L = '<a:AL:1422295291440140419>';
const EMOJI_I = '<a:AI:1422295171630108765>';
const EMOJI_S = '<a:AS:1422295527047041114>';
const FANCY_DIGITS = ['𝟎', '𝟏', '𝟐', '𝟑', '𝟒', '𝟓', '𝟔', '𝟕', '𝟖', '𝟗'] as const;
const LEVEL_UP_BANNER =
  `## ${EMOJI_YELLOW_HANGING_STARS} ${EMOJI_BABY_PINK_SPARKLIES} ` +
  `${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_BABY_PINK_SPARKLIES}` +
  `${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_PINK_SPARKLES} ` +
  `𝕷𝖊𝖛𝖊𝖑 𝖀𝖕${EMOJI_PINK_SPARKLES} ` +
  `${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_BABY_PINK_SPARKLIES}` +
  `${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_BABY_PINK_SPARKLIES}${EMOJI_BABY_PINK_SPARKLIES} ` +
  `${EMOJI_YELLOW_HANGING_STARS}`;
const CONGRATS_BANNER =
  `## ${EMOJI_HEART_POP} ${EMOJI_C} ${EMOJI_O} ${EMOJI_N} ${EMOJI_G} ${EMOJI_R} ` +
  `${EMOJI_A} ${EMOJI_T} ${EMOJI_U} ${EMOJI_L} ${EMOJI_A} ${EMOJI_T} ${EMOJI_I} ` +
  `${EMOJI_O} ${EMOJI_N} ${EMOJI_S}${EMOJI_HEART_POP}`;

const SPENT_ROLE_IDS = VIP_TIERS.flatMap((tier) => [tier.roleId, ...(tier.extraRoleIds ?? [])]);

const HEART_ROLE_TIERS: Tier[] = [
  { threshold: 131, roles: ['1430934504096399500', '1432091156199772363'] },
  { threshold: 520, roles: ['1432091440086913025'] },
  { threshold: 999, roles: ['1432091517496983614'] },
  { threshold: 1314, roles: ['1432091592390475917'] },
  { threshold: 3344, roles: ['1432091659264458802'] },
  { threshold: 5210, roles: ['1432091724892737617'] },
  { threshold: 6666, roles: ['1432091787593388214'] },
  { threshold: 9999, roles: ['1432091849190932541'] },
  { threshold: 13140, roles: ['1432091910159335618'] },
  { threshold: 33440, roles: ['1432091982104105130'] },
  { threshold: 52000, roles: ['1432092070243205190'] },
  { threshold: 99999, roles: ['1432092157686190393'] },
  { threshold: 131400, roles: ['1432092226560852009'] },
  { threshold: 334400, roles: ['1432092303777857687'] },
  { threshold: 999999, roles: ['1432092370803097853'] },
];
const HEART_ROLE_IDS = HEART_ROLE_TIERS.flatMap((tier) => tier.roles);

function computeRoleSet(totalSpent: number): string[] {
  const roleSet = new Set<string>();
  for (const tier of VIP_TIERS) {
    if (totalSpent >= tier.threshold) {
      roleSet.add(tier.roleId);
      for (const roleId of tier.extraRoleIds ?? []) roleSet.add(roleId);
    } else {
      break;
    }
  }
  return Array.from(roleSet);
}

function computeHeartRoleSet(heartValue: number): string[] {
  const roleSet = new Set<string>();
  for (const tier of HEART_ROLE_TIERS) {
    if (heartValue >= tier.threshold) {
      for (const roleId of tier.roles) {
        roleSet.add(roleId);
      }
    } else {
      break;
    }
  }
  return Array.from(roleSet);
}

function getHighestSpendTier(totalSpent: number): SpendRoleTier | null {
  return getHighestVipTierByTotalSpent(totalSpent);
}

function getHighestSpendTierFromRoles(roleIds: Iterable<string>): SpendRoleTier | null {
  const roleSet = new Set(roleIds);
  let matched: SpendRoleTier | null = null;
  for (const tier of VIP_TIERS) {
    if (roleSet.has(tier.roleId)) {
      matched = tier;
    }
  }
  return matched;
}

function formatFancyNumber(value: number): string {
  return String(value).replace(/\d/g, (digit) => FANCY_DIGITS[Number(digit)] ?? digit);
}

function buildCountMap(labels: string[]) {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

function formatBenefitLabels(labels: string[]) {
  return [...buildCountMap(labels).entries()].map(([label, count]) => (count > 1 ? `${label} x${count}` : label));
}

function collectMissingAutoBenefitLabels(previousVipLevel: number, currentVipLevel: number) {
  const labels: string[] = [];
  for (let vipLevel = previousVipLevel + 1; vipLevel <= currentVipLevel; vipLevel += 1) {
    for (const benefit of listOneTimeAutoBenefitsForLevel(vipLevel)) {
      for (let index = 0; index < benefit.quantity; index += 1) {
        labels.push(benefit.label);
      }
    }
  }
  return formatBenefitLabels(labels);
}

async function notifyVipBenefitGrantFailure(
  discordId: string,
  vipLevel: number,
  missingBenefits: string[],
  err: unknown,
) {
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) return;

  const errorText = err instanceof Error ? err.message : String(err);
  const missingLines =
    missingBenefits.length > 0 ? missingBenefits : ['本级无自动福利，请检查等级结算状态'];
  const content = [
    `${userMention(discordId)} VIP ${vipLevel} 福利发放失败`,
    '缺少福利：',
    ...missingLines.map((line) => `- ${line}`),
    '老板下次消费会进行重试，请不要重复发放',
  ].join('\n');

  try {
    if (VIP_BENEFIT_FAILURE_CHANNEL_ID) {
      const channel = await client.channels.fetch(VIP_BENEFIT_FAILURE_CHANNEL_ID).catch(() => null);
      if (channel?.isTextBased()) {
        const send = (channel as any).send?.bind(channel);
        if (typeof send === 'function') {
          await send({
            content,
            allowedMentions: { users: [discordId] },
          });
        }
      }
    }
  } catch (notifyErr) {
    console.error('[spent-role] vip benefit failure channel notify failed', {
      discordId,
      vipLevel,
      notifyErr,
    });
  }

  try {
    if (VIP_BENEFIT_FAILURE_NOTIFY_USER_ID) {
      const user = await client.users.fetch(VIP_BENEFIT_FAILURE_NOTIFY_USER_ID).catch(() => null);
      if (user) {
        await user.send(content);
      }
    }
  } catch (notifyErr) {
    console.error('[spent-role] vip benefit failure dm failed', {
      discordId,
      vipLevel,
      notifyErr,
    });
  }
}

async function loadDesiredHeartRoles(discordId: string) {
  const [heartSent, heartReceived] = await Promise.all([
    prisma.heartCounter.aggregate({
      _max: { total: true },
      where: { fromMemberId: discordId },
    }),
    prisma.heartCounter.aggregate({
      _max: { total: true },
      where: { toMemberId: discordId },
    }),
  ]);

  const maxSent = Number(heartSent._max?.total ?? 0);
  const maxReceived = Number(heartReceived._max?.total ?? 0);
  const heartValue = Math.max(maxSent, maxReceived);
  return computeHeartRoleSet(heartValue);
}

async function syncHeartRolesForGuildMember(guild: Guild, discordId: string) {
  const desiredHeartRoles = await loadDesiredHeartRoles(discordId);
  const member = await guild.members.fetch(discordId);
  const currentRoleIds = new Set(member.roles.cache.keys());
  const heartRolesToRemove = HEART_ROLE_IDS.filter(
    (roleId) => currentRoleIds.has(roleId) && !desiredHeartRoles.includes(roleId),
  );
  const missingHeartRoles = desiredHeartRoles.filter((roleId) => !currentRoleIds.has(roleId));

  if (heartRolesToRemove.length > 0) {
    await member.roles.remove(heartRolesToRemove);
    console.log('[spent-role] removed heart roles', { discordId, heartRolesToRemove });
  }
  if (missingHeartRoles.length > 0) {
    await member.roles.add(missingHeartRoles);
    console.log('[spent-role] assigned heart roles', { discordId, missingHeartRoles });
  }
}

async function postVipUpgradeAnnouncement(discordId: string, tier: SpendRoleTier) {
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client || !VIP_UPGRADE_ANNOUNCE_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(VIP_UPGRADE_ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const send = (channel as any).send?.bind(channel);
    if (typeof send !== 'function') return;

    const embed = new EmbedBuilder().setColor(0xf7c948).setImage(tier.imageUrl);
    const fancyVipLevel = formatFancyNumber(tier.vipLevel);
    const everyoneSuffix = tier.vipLevel >= 7 ? ' @everyone' : '';
    await send({
      content: [
        LEVEL_UP_BANNER,
        CONGRATS_BANNER,
        `## ${EMOJI_WHITE_PAW_BOUNCE} ${userMention(discordId)} 晋升至 ˗ˋˏ꒰ 𝓥𝓘𝓟 ${fancyVipLevel} · ${tier.name} ꒱ˎˊ˗ ${EMOJI_WHITE_PAW_BOUNCE}`,
        '',
        '*恭喜宝贝升级成功啦！',
        `从今天开始就是更闪亮的VIP啦～贴贴加倍，快乐翻倍！${everyoneSuffix}*`,
      ].join('\n'),
      embeds: [embed],
      allowedMentions:
        tier.vipLevel >= 7
          ? {
              parse: ['everyone'],
              users: [discordId],
            }
          : {
              users: [discordId],
            },
    });
  } catch (err) {
    console.error('[spent-role] vip upgrade announce failed', {
      discordId,
      roleId: tier.roleId,
      roleName: tier.name,
      err,
    });
  }
}

export async function replayCurrentVipUpgradeAnnouncement(discordId: string) {
  const memberRecord = await prisma.member.findUnique({
    where: { discordUserId: discordId },
    select: {
      totalSpent: true,
      vipBenefitProfile: {
        select: { announcementEnabled: true },
      },
    },
  });

  if (!memberRecord) {
    return { ok: false as const, reason: 'member_not_found' as const };
  }
  if (memberRecord.vipBenefitProfile?.announcementEnabled === false) {
    return { ok: false as const, reason: 'vip_announcement_opt_out' as const };
  }

  const totalSpentNumber = Number(memberRecord.totalSpent?.toString?.() ?? memberRecord.totalSpent ?? 0);
  const tier = getHighestSpendTier(totalSpentNumber);
  if (!tier) {
    return {
      ok: false as const,
      reason: 'no_vip_tier' as const,
      totalSpent: totalSpentNumber,
    };
  }

  await postVipUpgradeAnnouncement(discordId, tier);

  return {
    ok: true as const,
    discordId,
    totalSpent: totalSpentNumber,
    vipLevel: tier.vipLevel,
    tierName: tier.name,
    roleId: tier.roleId,
  };
}

export async function syncSpentRolesForMember(
  discordId: string,
  options: SyncSpentRoleOptions = {}
) {
  const includeSpendRoles = options.includeSpendRoles ?? true;
  const announceVipUpgrade = options.announceVipUpgrade ?? false;
  if (!SPENT_ROLE_GUILD_ID) {
    return;
  }

  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) {
    console.warn('[spent-role] no discord client');
    return;
  }

  const memberRecord = await prisma.member.findUnique({
    where: { discordUserId: discordId },
    select: {
      totalSpent: true,
      vipBenefitProfile: {
        select: {
          roleOptOut: true,
          announcementEnabled: true,
          lastSettledVipLevel: true,
        },
      },
    },
  });
  if (!memberRecord) {
    return;
  }

  const roleOptOut = memberRecord.vipBenefitProfile?.roleOptOut === true;
  const announcementEnabled = memberRecord.vipBenefitProfile?.announcementEnabled !== false;
  const persistedSettledVipLevel = Math.max(0, memberRecord.vipBenefitProfile?.lastSettledVipLevel ?? 0);
  const totalSpentNumber = includeSpendRoles
    ? Number(memberRecord.totalSpent?.toString?.() ?? memberRecord.totalSpent ?? 0)
    : 0;
  const spendRoles = includeSpendRoles && !roleOptOut ? computeRoleSet(totalSpentNumber) : [];
  const targetVipTier = includeSpendRoles ? getHighestSpendTier(totalSpentNumber) : null;

  const desiredHeartRoles = await loadDesiredHeartRoles(discordId);
  const desiredRoles = Array.from(new Set([...spendRoles, ...desiredHeartRoles]));
  const previousVipLevelForBenefits = includeSpendRoles ? persistedSettledVipLevel : 0;
  let vipRoleSynced = !roleOptOut;
  let shouldAnnounceVipUpgrade = false;
  let didAnnounceVipUpgrade = false;

  try {
    const guild = await client.guilds.fetch(SPENT_ROLE_GUILD_ID);
    const member = await guild.members.fetch(discordId);
    const currentRoleIds = new Set(member.roles.cache.keys());
    const currentVipTier =
      includeSpendRoles && !roleOptOut ? getHighestSpendTierFromRoles(currentRoleIds) : null;
    shouldAnnounceVipUpgrade =
      announceVipUpgrade &&
      announcementEnabled &&
      !!targetVipTier &&
      (!currentVipTier || targetVipTier.threshold > currentVipTier.threshold);

    const heartRolesToRemove = HEART_ROLE_IDS.filter(
      (roleId) => currentRoleIds.has(roleId) && !desiredHeartRoles.includes(roleId)
    );
    const spendRolesToRemove = includeSpendRoles
      ? SPENT_ROLE_IDS.filter((roleId) => currentRoleIds.has(roleId) && !spendRoles.includes(roleId))
      : [];
    const missingRoles = desiredRoles.filter((roleId) => !currentRoleIds.has(roleId));

    if (heartRolesToRemove.length > 0) {
      await member.roles.remove(heartRolesToRemove);
      console.log('[spent-role] removed heart roles', { discordId, heartRolesToRemove });
    }
    if (spendRolesToRemove.length > 0) {
      await member.roles.remove(spendRolesToRemove);
      console.log('[spent-role] removed spend roles', { discordId, spendRolesToRemove });
    }
    if (missingRoles.length > 0) {
      await member.roles.add(missingRoles);
      console.log('[spent-role] assigned roles', { discordId, missingRoles });
    }
  } catch (err) {
    vipRoleSynced = false;
    shouldAnnounceVipUpgrade = false;
    console.error('[spent-role] failed to assign roles', { discordId, err });
  }

  if (includeSpendRoles) {
    try {
      await reconcileVipBenefitsForMember(discordId, {
        previousVipLevel: previousVipLevelForBenefits,
        currentVipLevel: targetVipTier?.vipLevel ?? 0,
        vipRoleSynced,
      });
    } catch (err) {
      if (targetVipTier && targetVipTier.vipLevel > previousVipLevelForBenefits) {
        await notifyVipBenefitGrantFailure(
          discordId,
          targetVipTier.vipLevel,
          collectMissingAutoBenefitLabels(previousVipLevelForBenefits, targetVipTier.vipLevel),
          err,
        );
      }
      throw err;
    }

    if (shouldAnnounceVipUpgrade && targetVipTier) {
      await postVipUpgradeAnnouncement(discordId, targetVipTier);
      didAnnounceVipUpgrade = true;
    }

    if (
      didAnnounceVipUpgrade &&
      targetVipTier &&
      previousVipLevelForBenefits >= targetVipTier.vipLevel
    ) {
      await sendVipBenefitOverviewDm(discordId, targetVipTier.vipLevel, { vipRoleSynced });
    }
  }
}

export function scheduleSpentRoleSync(
  discordId: string,
  options: SyncSpentRoleOptions = {}
) {
  const previous = spentRoleSyncQueue.get(discordId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => syncSpentRolesForMember(discordId, options))
    .catch((err) => {
    console.error('[spent-role] schedule failed', { discordId, options, err });
    });
  spentRoleSyncQueue.set(discordId, current);
  void current.finally(() => {
    if (spentRoleSyncQueue.get(discordId) === current) {
      spentRoleSyncQueue.delete(discordId);
    }
  });
}

/** Re-sync all members’ heart roles under the latest single-object logic */
export async function resyncAllHeartRoles() {
  const client = (globalThis as any).__CLIENT__ as Client | undefined;
  if (!client) {
    console.warn('[spent-role] no discord client, skip resync');
    return;
  }
  if (!SPENT_ROLE_GUILD_ID) {
    console.warn('[spent-role] no guild id, skip heart resync');
    return;
  }
  const guild = await client.guilds.fetch(SPENT_ROLE_GUILD_ID);
  const members = await prisma.member.findMany({
    select: { discordUserId: true },
  });
  for (const m of members) {
    try {
      await syncHeartRolesForGuildMember(guild, m.discordUserId);
    } catch (err) {
      console.error('[spent-role] resync member failed', { discordId: m.discordUserId, err });
    }
  }
}
