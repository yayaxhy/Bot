import assert from 'node:assert/strict';
import test from 'node:test';
import { LotteryPool } from '@prisma/client';
import { resolveVoucherCouponDisplayName } from '../config/voucherCatalog.js';
import {
  buildBotLotteryFusionRequestId,
  buildLotteryFusionSelectableGroups,
  clampLotteryFusionTargetCount,
  getDefaultLotteryFusionTargetCount,
  isWebLotteryFusionRequestId,
  syncLotteryFusionSelection,
  takeLastSelectedSourceIdFromFusionGroup,
  takeNextSourceIdFromFusionGroup,
  type LotteryFusionSelectableItem,
} from './lotteryFusionBotService.js';
import {
  buildLotteryFusionBotSuccessMessage,
  buildLotteryFusionWebSuccessMessage,
} from './lotteryFusionNotificationService.js';

test('buildLotteryFusionSelectableGroups merges same-name items and orders source ids by earliest expiry', () => {
  const items: LotteryFusionSelectableItem[] = [
    {
      sourceId: 'lottery:A',
      sourceKind: 'lottery',
      prizeName: '钢琴代金券',
      pool: LotteryPool.ADVANCED,
      createdAt: new Date('2026-07-09T10:00:00.000Z'),
      expiresAt: new Date('2026-08-09T00:00:00.000Z'),
    },
    {
      sourceId: 'coupon:B',
      sourceKind: 'coupon',
      prizeName: '钢琴代金券',
      pool: LotteryPool.ADVANCED,
      createdAt: new Date('2026-07-08T10:00:00.000Z'),
      expiresAt: new Date('2026-07-20T00:00:00.000Z'),
    },
    {
      sourceId: 'pointshop:C',
      sourceKind: 'pointshop',
      prizeName: '香槟代金券',
      pool: LotteryPool.MEDIUM,
      createdAt: new Date('2026-07-07T10:00:00.000Z'),
      expiresAt: null,
    },
  ];

  const groups = buildLotteryFusionSelectableGroups(items);
  assert.equal(groups.length, 2);

  const pianoGroup = groups.find((group) => group.prizeName === '钢琴代金券');
  assert.ok(pianoGroup);
  assert.equal(pianoGroup?.count, 2);
  assert.deepEqual(pianoGroup?.sourceIds, ['coupon:B', 'lottery:A']);
  assert.equal(pianoGroup?.earliestExpiresAt?.toISOString(), '2026-07-20T00:00:00.000Z');
});

test('selection helpers respect grouped counts and filter stale source ids', () => {
  const group = {
    sourceIds: ['coupon:1', 'coupon:2', 'coupon:3'],
  };

  assert.equal(takeNextSourceIdFromFusionGroup(group, []), 'coupon:1');
  assert.equal(takeNextSourceIdFromFusionGroup(group, ['coupon:1']), 'coupon:2');
  assert.equal(
    takeLastSelectedSourceIdFromFusionGroup(group, ['coupon:1', 'coupon:3']),
    'coupon:3',
  );
  assert.deepEqual(
    syncLotteryFusionSelection(
      ['coupon:1', 'coupon:404', 'lottery:x'],
      [{ sourceId: 'coupon:1' }, { sourceId: 'lottery:x' }],
    ),
    ['coupon:1', 'lottery:x'],
  );
});

test('fusion count helpers and web notification builders follow the expected rules', () => {
  assert.equal(getDefaultLotteryFusionTargetCount(3), 3);
  assert.equal(getDefaultLotteryFusionTargetCount(6), 4);
  assert.equal(clampLotteryFusionTargetCount(6, 5), 4);
  assert.equal(clampLotteryFusionTargetCount(4, 2), 3);
  assert.equal(isWebLotteryFusionRequestId('WEB_FUSION:abc'), true);
  assert.equal(isWebLotteryFusionRequestId(buildBotLotteryFusionRequestId('abc')), false);

  assert.equal(buildLotteryFusionBotSuccessMessage('钢琴代金券'), '恭喜您🎉 重铸获得钢琴代金券');
  assert.equal(
    buildLotteryFusionWebSuccessMessage({
      prizeName: '钢琴代金券',
      discordUserId: '123',
    }),
    '恭喜用户 <@123> 🎉 重铸获得钢琴代金券',
  );
});

test('resolveVoucherCouponDisplayName maps coupon codes to Chinese labels', () => {
  assert.equal(resolveVoucherCouponDisplayName('DISCOUNT_90_LOTTERY'), '特殊9折券');
  assert.equal(resolveVoucherCouponDisplayName('DISCOUNT_90'), '9折券');
  assert.equal(resolveVoucherCouponDisplayName(undefined, 'DISCOUNT_80'), '8折券');
});
