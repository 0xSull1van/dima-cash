import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CASHOUT_ONCE_DEFAULT_CFG,
  buildCashoutPlan,
  parseCashoutOnceArgs,
} from '../scripts/cashout-once.js';

test('parseCashoutOnceArgs defaults to dry-run plan mode', () => {
  const args = parseCashoutOnceArgs([]);
  assert.equal(args.accountName, 'Zephyr');
  assert.equal(args.command, 'plan');
  assert.equal(args.write, false);
});

test('parseCashoutOnceArgs requires explicit write commands', () => {
  assert.equal(parseCashoutOnceArgs(['Mira', 'list']).write, true);
  assert.equal(parseCashoutOnceArgs(['Mira', 'cancel', 'listing-1']).write, true);
  assert.equal(parseCashoutOnceArgs(['Mira', 'plan']).write, false);
  assert.throws(() => parseCashoutOnceArgs(['Mira', 'cancel']), /listing id/i);
});

test('buildCashoutPlan skips when active gold listing cap is reached', () => {
  const rows = [
    { id: 'a', itemKind: 'gold', currency: 'zenko', status: 'active' },
    { id: 'b', itemKind: 'gold', currency: 'zenko', status: 'listed' },
    { id: 'c', itemKind: 'gold', currency: 'zenko' },
    { id: 'sold', itemKind: 'gold', currency: 'zenko', status: 'sold' },
  ];
  const plan = buildCashoutPlan({
    gold: 1_000_000,
    floorUsd: 0.000002,
    myGoldListings: rows,
    rng: () => 0,
    cfg: { ...CASHOUT_ONCE_DEFAULT_CFG, cashoutMaxActiveListings: 3 },
  });

  assert.equal(plan.mode, 'skip');
  assert.equal(plan.reason, 'max-active-listings');
  assert.equal(plan.activeGoldListings, 3);
});

test('buildCashoutPlan returns one listable gold lot when safe', () => {
  const plan = buildCashoutPlan({
    gold: 1_000_000,
    floorUsd: 0.000002,
    myGoldListings: [{ id: 'old', itemKind: 'gold', currency: 'zenko', status: 'sold' }],
    rng: () => 0,
    cfg: {
      ...CASHOUT_ONCE_DEFAULT_CFG,
      cashoutChunkFracMin: 0.2,
      cashoutChunkFracMax: 0.2,
      cashoutPriceJitterMin: 1,
      cashoutPriceJitterMax: 1,
    },
  });

  assert.equal(plan.mode, 'list');
  assert.equal(plan.activeGoldListings, 0);
  assert.ok(plan.quantity >= CASHOUT_ONCE_DEFAULT_CFG.cashoutMinLotGold);
  assert.ok(plan.priceUsd >= CASHOUT_ONCE_DEFAULT_CFG.cashoutMinPriceUsd);
});
