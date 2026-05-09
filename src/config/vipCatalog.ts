import { CouponType } from '@prisma/client';

export type VipOneTimeAutoBenefit =
  | {
      code: string;
      label: string;
      kind: 'coupon';
      couponType: CouponType;
      quantity: number;
      revocable: true;
    }
  | {
      code: string;
      label: string;
      kind: 'lottery';
      lotteryPrizeName: string;
      quantity: number;
      revocable: true;
    }
  | {
      code: string;
      label: string;
      kind: 'points';
      pointsAmount: string;
      quantity: 1;
      revocable: false;
    };

export type VipTierConfig = {
  vipLevel: number;
  threshold: number;
  roleId: string;
  name: string;
  imageUrl: string;
  extraRoleIds?: string[];
  tagLabel: string;
  pointBonusRate: number;
  oneTimeAutoBenefits: VipOneTimeAutoBenefit[];
  manualBenefits: string[];
};

const LOTTERY_VOUCHER_PRIZE_NAME = '抽奖代金券';

export const VIP_TIERS: VipTierConfig[] = [
  {
    vipLevel: 1,
    threshold: 500,
    roleId: '1431674463401017364',
    name: '锦鲤',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735389035266208/VIP1.png?ex=69cddc60&is=69cc8ae0&hm=aaa4a11b82b0dfc9dd7cfad19ec68a050042cd70f4046ea22c803348d7a09352',
    extraRoleIds: ['1430926034873614418'],
    tagLabel: '对应 VIP TAG',
    pointBonusRate: 0,
    oneTimeAutoBenefits: [],
    manualBenefits: [],
  },
  {
    vipLevel: 2,
    threshold: 1500,
    roleId: '1431678158675116192',
    name: '金锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735410505912430/VIP2.png?ex=69cddc65&is=69cc8ae5&hm=4e02b965237c9d2fd8b8709ce3ed5031297423ba554a8ae0c591eb3225f3056d',
    tagLabel: '对应 VIP TAG',
    pointBonusRate: 0,
    oneTimeAutoBenefits: [
      {
        code: 'VIP2_PEIWAN_90',
        label: '陪玩 9 折优惠券',
        kind: 'coupon',
        couponType: CouponType.DISCOUNT_90,
        quantity: 1,
        revocable: true,
      },
    ],
    manualBenefits: [],
  },
  {
    vipLevel: 3,
    threshold: 3000,
    roleId: '1431678273250918451',
    name: '玉锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735433553612882/VIP3.png?ex=69cddc6a&is=69cc8aea&hm=5ac20696ea3ed3e48ddf93d8d304ceb08991b47da9223d3604b31923c084049a',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0,
    oneTimeAutoBenefits: [
      {
        code: 'VIP3_PEIWAN_90',
        label: '陪玩 9 折优惠券',
        kind: 'coupon',
        couponType: CouponType.DISCOUNT_90,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP3_POINTS_1000',
        label: '1000 锦鲤积分',
        kind: 'points',
        pointsAmount: '1000',
        quantity: 1,
        revocable: false,
      },
    ],
    manualBenefits: [],
  },
  {
    vipLevel: 4,
    threshold: 5000,
    roleId: '1431678352338452603',
    name: '瑞锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735453648523354/VIP4.png?ex=69cddc6f&is=69cc8aef&hm=d1c62aa9c29b7ec6d23c65f7c015bd51d87f682e6b988ec9f2423e78a77fa47e',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0,
    oneTimeAutoBenefits: [
      {
        code: 'VIP4_LOTTERY_VOUCHER',
        label: '抽奖代金券',
        kind: 'coupon',
        couponType: CouponType.LOTTERY_VOUCHER,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP4_POINTS_3000',
        label: '3000 锦鲤积分',
        kind: 'points',
        pointsAmount: '3000',
        quantity: 1,
        revocable: false,
      },
    ],
    manualBenefits: [],
  },
  {
    vipLevel: 5,
    threshold: 10000,
    roleId: '1431678419053056071',
    name: '祥锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735494128009407/VIP5.png?ex=69cddc79&is=69cc8af9&hm=37ba4d4dec29e9be40ee02f19ddc3b1d1b37d0dbaf57bad6421c6b31ceeb6a03',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.1,
    oneTimeAutoBenefits: [
      {
        code: 'VIP5_CUSTOM_GIFT',
        label: '自定义礼物券',
        kind: 'coupon',
        couponType: CouponType.CUSTOM_GIFT_VOUCHER,
        quantity: 1,
        revocable: true,
      },
    ],
    manualBenefits: ['老板免费入职'],
  },
  {
    vipLevel: 6,
    threshold: 20000,
    roleId: '1431678531963850804',
    name: '福锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735516059762688/VIP6.png?ex=69cddc7e&is=69cc8afe&hm=ef78c9090f734e78ea10d137be5af30cc843b5977a00f322f8872669f345b5a4',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.1,
    oneTimeAutoBenefits: [
      {
        code: 'VIP6_LOTTERY_VOUCHER',
        label: '抽奖代金券',
        kind: 'coupon',
        couponType: CouponType.LOTTERY_VOUCHER,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP6_BLOCK_STACK_VOUCHER',
        label: '抽积木代金券',
        kind: 'coupon',
        couponType: CouponType.BLOCK_STACK_VOUCHER,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP6_SCRATCH_VOUCHER',
        label: '刮刮乐代金券',
        kind: 'coupon',
        couponType: CouponType.SCRATCH_TICKET_VOUCHER,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP6_DOUBLE_SPEND_5000',
        label: '双倍消费 5000 代金券',
        kind: 'coupon',
        couponType: CouponType.DOUBLE_SPEND_5000_VOUCHER,
        quantity: 1,
        revocable: true,
      },
    ],
    manualBenefits: ['自定义日冠、冠名后缀'],
  },
  {
    vipLevel: 7,
    threshold: 50000,
    roleId: '1431678630265618433',
    name: '跃锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735536452599878/VIP7.png?ex=69cddc83&is=69cc8b03&hm=79b8f08ab40ca024e363f5b77fb7307fb4ce775dcd632a8f9e587e0549134f35',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.15,
    oneTimeAutoBenefits: [
      {
        code: 'VIP7_CROWN_75',
        label: '一日冠 75 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_75_VOUCHER,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP7_CROWN_3DAY_90',
        label: '三日冠 9 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_3DAY_90_VOUCHER,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP7_CROWN_WEEK_90',
        label: '一周冠 9 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_WEEK_90_VOUCHER,
        quantity: 1,
        revocable: true,
      },
    ],
    manualBenefits: ['永久自定义 TAG（可送 3 人，需双方同意）', '自定义陪玩后缀（30 日）'],
  },
  {
    vipLevel: 8,
    threshold: 120000,
    roleId: '1431678711312416918',
    name: '龙门锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735562431987844/VIP8.png?ex=69cddc89&is=69cc8b09&hm=5eef633745979dd387ce1aa844049c0bcc14dada915fc7a9b9042abec0f7eb4f',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.15,
    oneTimeAutoBenefits: [
      {
        code: 'VIP8_CROWN_75',
        label: '一日冠 75 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_75_VOUCHER,
        quantity: 3,
        revocable: true,
      },
      {
        code: 'VIP8_CROWN_MONTH_90',
        label: '月冠名 9 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_MONTH_90_VOUCHER,
        quantity: 1,
        revocable: true,
      },
      {
        code: 'VIP8_LOTTERY_VOUCHER',
        label: '陪玩抽奖代金券',
        kind: 'coupon',
        couponType: CouponType.LOTTERY_VOUCHER,
        quantity: 6,
        revocable: true,
      },
      {
        code: 'VIP8_POINTS_9999',
        label: '9999 锦鲤积分',
        kind: 'points',
        pointsAmount: '9999',
        quantity: 1,
        revocable: false,
      },
    ],
    manualBenefits: ['自定义礼物价格解锁', '自定义 TAG 送人上限提升至 12 人', '一周机器人冠名'],
  },
  {
    vipLevel: 9,
    threshold: 210000,
    roleId: '1431678784712605856',
    name: '化龙锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735586914140290/VIP9.png?ex=69cddc8f&is=69cc8b0f&hm=0c526bdca3ea204827a9c6b4d2a5a185e12a4a27be0f9b0eaf33b07404d664a8',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.2,
    oneTimeAutoBenefits: [
      {
        code: 'VIP9_REVIEW_VOUCHER',
        label: '陪玩评语券',
        kind: 'coupon',
        couponType: CouponType.PEIWAN_REVIEW_VOUCHER,
        quantity: 3,
        revocable: true,
      },
    ],
    manualBenefits: [
      '专属等级派单播报图片 / 自定义图片',
      '每月首充赠送 1%（不可与其他充值返利叠加）',
      '每月推荐一位陪玩上官网推荐位',
      '自定义 TAG 永久置顶（不含送人 TAG）',
      '专属下单厅和语音频道',
      '一天公会冠名',
    ],
  },
  {
    vipLevel: 10,
    threshold: 340000,
    roleId: '1478021398491562054',
    name: '隐龙锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735613480993030/VIP10.png?ex=69cddc95&is=69cc8b15&hm=45963d1a39bcd7368195d43a488f9318e432a61db94b834dc13eeb8e2ce18173',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.25,
    oneTimeAutoBenefits: [],
    manualBenefits: [
      '专属等级派单播报图片',
      '一周工会冠名',
      '专属红包封面',
      '自定义点单成功提示',
      '专属区欢迎排面、专属进场播报',
    ],
  },
  {
    vipLevel: 11,
    threshold: 520000,
    roleId: '1478023200674811955',
    name: '游龙锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735646817452073/VIP11.png?ex=69cddc9d&is=69cc8b1d&hm=3175ec27e36a3028f52104dbcbd1574140ea3c8d1faa7b2d7d129d924e211b93',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.3,
    oneTimeAutoBenefits: [
      {
        code: 'VIP11_CROWN_75',
        label: '一日冠 75 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_75_VOUCHER,
        quantity: 3,
        revocable: true,
      },
      {
        code: 'VIP11_CROWN_3DAY_90',
        label: '三日冠 9 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_3DAY_90_VOUCHER,
        quantity: 3,
        revocable: true,
      },
      {
        code: 'VIP11_CROWN_WEEK_90',
        label: '一周冠 9 折券',
        kind: 'coupon',
        couponType: CouponType.CROWN_WEEK_90_VOUCHER,
        quantity: 3,
        revocable: true,
      },
      {
        code: 'VIP11_LOTTERY_VOUCHER',
        label: '抽奖代金券',
        kind: 'coupon',
        couponType: CouponType.LOTTERY_VOUCHER,
        quantity: 5,
        revocable: true,
      },
      {
        code: 'VIP11_BLOCK_STACK_VOUCHER',
        label: '抽积木代金券',
        kind: 'coupon',
        couponType: CouponType.BLOCK_STACK_VOUCHER,
        quantity: 5,
        revocable: true,
      },
      {
        code: 'VIP11_SCRATCH_VOUCHER',
        label: '刮刮乐代金券',
        kind: 'coupon',
        couponType: CouponType.SCRATCH_TICKET_VOUCHER,
        quantity: 5,
        revocable: true,
      },
    ],
    manualBenefits: [
      '30 天工会冠名',
      '每月首充赠送 2%（不可与其他充值返利叠加）',
    ],
  },
  {
    vipLevel: 12,
    threshold: 880000,
    roleId: '1478022587350253718',
    name: '御龙锦',
    imageUrl:
      'https://cdn.discordapp.com/attachments/1488734945810579476/1488735664374677644/VIP12.png?ex=69cddca1&is=69cc8b21&hm=6ab43e88ace200db8c61c4047f4f9e3b94fa318607006f454a20bacb80cd5695',
    tagLabel: '对应 VIP 独立分组 TAG',
    pointBonusRate: 0.4,
    oneTimeAutoBenefits: [],
    manualBenefits: [
      '1 对 1 定制公会小游戏',
      '90 天工会冠名',
      '1 对 1 客服',
      '每月首充赠送 3%（不可与其他充值返利叠加）',
      '来自工会的神秘大奖',
      '派单 / 红包 / 小游戏 / 房间 / 全部单独定制',
    ],
  },
];

export const VIP_TIER_BY_LEVEL = new Map(VIP_TIERS.map((tier) => [tier.vipLevel, tier] as const));

export function getVipTierByLevel(vipLevel: number): VipTierConfig | null {
  return VIP_TIER_BY_LEVEL.get(vipLevel) ?? null;
}

export function getHighestVipTierByTotalSpent(totalSpent: number): VipTierConfig | null {
  let matched: VipTierConfig | null = null;
  for (const tier of VIP_TIERS) {
    if (totalSpent >= tier.threshold) {
      matched = tier;
    } else {
      break;
    }
  }
  return matched;
}

export function getPointBonusRateByVipLevel(vipLevel: number): number {
  return getVipTierByLevel(vipLevel)?.pointBonusRate ?? 0;
}

export function getPointBonusRateByTotalSpent(totalSpent: number): number {
  return getHighestVipTierByTotalSpent(totalSpent)?.pointBonusRate ?? 0;
}

export function listOneTimeAutoBenefitsForLevel(vipLevel: number): VipOneTimeAutoBenefit[] {
  return getVipTierByLevel(vipLevel)?.oneTimeAutoBenefits ?? [];
}
