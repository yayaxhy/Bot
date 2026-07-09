import assert from 'node:assert/strict';
import test from 'node:test';
import { LotteryPool } from '@prisma/client';
import {
  LOTTERY_FUSION_DRAW_NONCE_PREFIX,
  getFusionEligiblePools,
  isLotteryFusionNonce,
  parseLotteryFusionSourceRef,
} from './lotteryFusionRules.js';

test('getFusionEligiblePools returns the configured pool range for 3 fusion', () => {
  assert.deepEqual(getFusionEligiblePools(3), [LotteryPool.NORMAL, LotteryPool.MEDIUM]);
});

test('getFusionEligiblePools returns the configured pool range for 4 fusion', () => {
  assert.deepEqual(getFusionEligiblePools(4), [LotteryPool.NORMAL, LotteryPool.MEDIUM, LotteryPool.ADVANCED]);
});

test('getFusionEligiblePools excludes normal pool for 6 fusion', () => {
  assert.deepEqual(getFusionEligiblePools(6), [LotteryPool.MEDIUM, LotteryPool.ADVANCED, LotteryPool.SPECIAL]);
});

test('getFusionEligiblePools rejects unsupported counts', () => {
  assert.equal(getFusionEligiblePools(5), null);
});

test('isLotteryFusionNonce only matches fusion output nonces', () => {
  assert.equal(isLotteryFusionNonce(`${LOTTERY_FUSION_DRAW_NONCE_PREFIX}abc123`), true);
  assert.equal(isLotteryFusionNonce('vip:abc123'), false);
  assert.equal(isLotteryFusionNonce(''), false);
  assert.equal(isLotteryFusionNonce(null), false);
});

test('parseLotteryFusionSourceRef accepts prefixed and legacy lottery ids', () => {
  assert.deepEqual(parseLotteryFusionSourceRef('coupon:C1'), { kind: 'coupon', id: 'C1' });
  assert.deepEqual(parseLotteryFusionSourceRef('pointshop:G1'), { kind: 'pointshop', id: 'G1' });
  assert.deepEqual(parseLotteryFusionSourceRef('draw123'), { kind: 'lottery', id: 'draw123' });
  assert.equal(parseLotteryFusionSourceRef('unknown:1'), null);
});
