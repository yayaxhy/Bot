import { CouponType } from '@prisma/client';
import { PRIZE_NAMES } from '../services/lotteryService.js';

type GiftVoucherOption = {
  giftName: string;
  prizeName: string;
  couponType?: CouponType;
  payRate: number;
};

const GIFT_VOUCHER_OPTIONS: GiftVoucherOption[] = [
  { giftName: '小蛋糕', prizeName: PRIZE_NAMES.CAKE_VOUCHER, couponType: CouponType.CAKE_VOUCHER, payRate: 0 },
  { giftName: '棒棒糖', prizeName: PRIZE_NAMES.LOLLIPOP_VOUCHER, couponType: CouponType.LOLLIPOP_VOUCHER, payRate: 0 },
  { giftName: '香水', prizeName: PRIZE_NAMES.PERFUME_VOUCHER, couponType: CouponType.PERFUME_VOUCHER, payRate: 0 },
  {
    giftName: '旋转木马',
    prizeName: PRIZE_NAMES.CAROUSEL_VOUCHER,
    couponType: CouponType.CAROUSEL_VOUCHER,
    payRate: 0,
  },
  {
    giftName: '南瓜车',
    prizeName: PRIZE_NAMES.PUMPKIN_CAR_VOUCHER,
    couponType: CouponType.PUMPKIN_CAR_VOUCHER,
    payRate: 0,
  },
  {
    giftName: '留声机',
    prizeName: PRIZE_NAMES.PHONOGRAPH_VOUCHER,
    couponType: CouponType.PHONOGRAPH_VOUCHER,
    payRate: 0,
  },
  { giftName: '一日冠', prizeName: PRIZE_NAMES.CROWN_DAY_90_VOUCHER, couponType: CouponType.CROWN_DAY_90_VOUCHER, payRate: 0.9 },
  { giftName: '一日冠', prizeName: PRIZE_NAMES.CROWN_75_VOUCHER, couponType: CouponType.CROWN_75_VOUCHER, payRate: 0.75 },
  { giftName: '三日冠', prizeName: PRIZE_NAMES.CROWN_3DAY_90_VOUCHER, couponType: CouponType.CROWN_3DAY_90_VOUCHER, payRate: 0.9 },
  { giftName: '一周冠', prizeName: PRIZE_NAMES.CROWN_WEEK_90_VOUCHER, couponType: CouponType.CROWN_WEEK_90_VOUCHER, payRate: 0.9 },
  { giftName: '月冠名', prizeName: PRIZE_NAMES.CROWN_MONTH_90_VOUCHER, couponType: CouponType.CROWN_MONTH_90_VOUCHER, payRate: 0.9 },
  { giftName: '兔兔宝宝', prizeName: PRIZE_NAMES.RABBIT_BABY, payRate: 0 },
  { giftName: '狐狸宝宝', prizeName: PRIZE_NAMES.FOX_BABY, payRate: 0 },
  { giftName: '猪猪宝宝', prizeName: PRIZE_NAMES.PIGGY_BABY, payRate: 0 },
  { giftName: '小鸡宝宝', prizeName: PRIZE_NAMES.CHICK_BABY, payRate: 0 },
];

const SPECIAL_ACTION_VOUCHERS = [
  { prizeName: PRIZE_NAMES.CUSTOM_GIFT_VOUCHER, couponType: CouponType.CUSTOM_GIFT_VOUCHER },
  { prizeName: PRIZE_NAMES.CUSTOM_TAG_VOUCHER, couponType: CouponType.CUSTOM_TAG_VOUCHER },
  { prizeName: PRIZE_NAMES.COMMISSION_MINUS1_VOUCHER, couponType: CouponType.COMMISSION_MINUS1_VOUCHER },
  { prizeName: PRIZE_NAMES.DOUBLE_FLOW_5000_VOUCHER, couponType: CouponType.DOUBLE_FLOW_5000_VOUCHER },
  { prizeName: PRIZE_NAMES.DOUBLE_SPEND_5000_VOUCHER, couponType: CouponType.DOUBLE_SPEND_5000_VOUCHER },
  { prizeName: '刮刮乐代金券', couponType: CouponType.SCRATCH_TICKET_VOUCHER },
  { prizeName: PRIZE_NAMES.PEIWAN_REVIEW_VOUCHER, couponType: CouponType.PEIWAN_REVIEW_VOUCHER },
] as const;

const RENAME_CARD_VOUCHERS = [
  { prizeName: PRIZE_NAMES.RENAME_CARD_3, couponType: CouponType.RENAME_CARD_3 },
  { prizeName: PRIZE_NAMES.RENAME_CARD, couponType: CouponType.RENAME_CARD },
  { prizeName: PRIZE_NAMES.RENAME_CARD_5, couponType: CouponType.RENAME_CARD_5 },
] as const;

const ALL_VOUCHERS = [
  ...GIFT_VOUCHER_OPTIONS
    .filter((entry): entry is GiftVoucherOption & { couponType: CouponType } => !!entry.couponType)
    .map((entry) => ({ prizeName: entry.prizeName, couponType: entry.couponType })),
  ...SPECIAL_ACTION_VOUCHERS,
  ...RENAME_CARD_VOUCHERS,
];

export const GIFT_VOUCHER_CONFIGS: Record<string, Array<{ prizeName: string; payRate: number }>> =
  GIFT_VOUCHER_OPTIONS.reduce((acc, entry) => {
    if (!acc[entry.giftName]) {
      acc[entry.giftName] = [];
    }
    acc[entry.giftName].push({ prizeName: entry.prizeName, payRate: entry.payRate });
    return acc;
  }, {} as Record<string, Array<{ prizeName: string; payRate: number }>>);

export const GIFT_VOUCHER_NAMES = new Set(GIFT_VOUCHER_OPTIONS.map((entry) => entry.prizeName));

export const VOUCHER_COUPON_TYPE_BY_PRIZE: Partial<Record<string, CouponType>> = ALL_VOUCHERS.reduce(
  (acc, entry) => {
    acc[entry.prizeName] = entry.couponType;
    return acc;
  },
  {} as Partial<Record<string, CouponType>>,
);

export const PRIZE_BY_VOUCHER_COUPON_TYPE: Partial<Record<CouponType, string>> = ALL_VOUCHERS.reduce(
  (acc, entry) => {
    acc[entry.couponType] = entry.prizeName;
    return acc;
  },
  {} as Partial<Record<CouponType, string>>,
);

export const RENAME_CARD_COUPON_TYPES: CouponType[] = RENAME_CARD_VOUCHERS.map((entry) => entry.couponType);
