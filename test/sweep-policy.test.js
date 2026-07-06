import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SWEEP_MIN_SWEEP_ZOLANA,
  DEFAULT_SWEEP_TOKEN_FLOOR_ZOLANA,
  calculateZolanaSweep,
  parseSweepPolicyArgs,
  tokenAmountToRawUnits,
} from '../src/sweep-policy.js';

test('calculates default ZOLANA sweep above the token floor', () => {
  const result = calculateZolanaSweep({
    balanceRaw: 7_000_000_000n,
    decimals: 6,
  });

  assert.equal(DEFAULT_SWEEP_TOKEN_FLOOR_ZOLANA, '6500');
  assert.equal(DEFAULT_SWEEP_MIN_SWEEP_ZOLANA, '0');
  assert.equal(result.have, 7_000_000_000n);
  assert.equal(result.floor, 6_500_000_000n);
  assert.equal(result.minSweep, 0n);
  assert.equal(result.excess, 500_000_000n);
  assert.equal(result.sweepAmount, 500_000_000n);
});

test('does not sweep when balance is at or below the token floor', () => {
  assert.equal(calculateZolanaSweep({ balanceRaw: 6_500n, decimals: 0 }).sweepAmount, 0n);
  assert.equal(calculateZolanaSweep({ balanceRaw: 6_499n, decimals: 0 }).sweepAmount, 0n);
});

test('min sweep suppresses dust without changing the retained floor', () => {
  const dust = calculateZolanaSweep({
    balanceRaw: 650_050n,
    decimals: 2,
    tokenFloorZolana: '6500',
    minSweepZolana: '1.25',
  });

  assert.equal(dust.floor, 650_000n);
  assert.equal(dust.minSweep, 125n);
  assert.equal(dust.excess, 50n);
  assert.equal(dust.sweepAmount, 0n);

  const enough = calculateZolanaSweep({
    balanceRaw: 650_200n,
    decimals: 2,
    tokenFloorZolana: '6500',
    minSweepZolana: '1.25',
  });

  assert.equal(enough.excess, 200n);
  assert.equal(enough.sweepAmount, 200n);
});

test('converts decimal token options to raw units without float math', () => {
  assert.equal(tokenAmountToRawUnits('6500.123456', 6, 'floor'), 6_500_123_456n);
  assert.equal(tokenAmountToRawUnits('0.000001', 6, 'min sweep'), 1n);
});

test('rejects invalid sweep policy inputs', () => {
  assert.throws(
    () => calculateZolanaSweep({ balanceRaw: 1n, decimals: -1 }),
    /invalid token decimals/,
  );
  assert.throws(
    () => calculateZolanaSweep({ balanceRaw: -1n, decimals: 6 }),
    /invalid token balance/,
  );
  assert.throws(
    () => calculateZolanaSweep({ balanceRaw: 1n, decimals: 6, tokenFloorZolana: '-1' }),
    /invalid token floor/,
  );
  assert.throws(
    () => calculateZolanaSweep({ balanceRaw: 1n, decimals: 6, minSweepZolana: '0.0000001' }),
    /too many decimal places/,
  );
});

test('parses dry-run sweep policy defaults and explicit CLI overrides', () => {
  assert.deepEqual(parseSweepPolicyArgs([], {}), {
    live: false,
    tokenFloorZolana: '6500',
    minSweepZolana: '0',
  });

  assert.deepEqual(parseSweepPolicyArgs([
    '--live',
    '--token-floor=7000.5',
    '--min-sweep=25',
  ], {}), {
    live: true,
    tokenFloorZolana: '7000.5',
    minSweepZolana: '25',
  });
});

test('parses env sweep policy without making live mode env-configurable', () => {
  assert.deepEqual(parseSweepPolicyArgs([], {
    ZENKO_SWEEP_TOKEN_FLOOR_ZOLANA: '7200',
    ZENKO_SWEEP_MIN_SWEEP_ZOLANA: '10.5',
    ZENKO_SWEEP_LIVE: '1',
  }), {
    live: false,
    tokenFloorZolana: '7200',
    minSweepZolana: '10.5',
  });
});

// ── ZOLANA rebalance 2026-07-06 (owner: "everyone always at ~12000; below 10k, let another account share")
import { planZolanaRebalance } from '../src/zolana-rebalance.js';

test('planZolanaRebalance: donors cover needs, a donor stays above the floor, amounts are non-round', () => {
  const rng = () => 0.5;
  const plan = planZolanaRebalance([
    { name: 'rich', address: 'R1', zolana: 21_000 },   // avail = 21000-13500 = 7500
    { name: 'mid', address: 'M1', zolana: 12_500 },    // neither a donor (below the floor) nor a recipient
    { name: 'poor', address: 'P1', zolana: 8_000 },    // need ≈ (12000-8000)×1.02 + 8 ≈ 4088
  ], { rng });
  assert.equal(plan.transfers.length, 1);
  const t = plan.transfers[0];
  assert.equal(t.from, 'rich'); assert.equal(t.to, 'poor');
  assert.ok(t.amount >= 4000 && t.amount <= 4300, `need with jitter (got ${t.amount})`);
  assert.ok(t.amount % 100 !== 0, 'non-round amount');
  assert.equal(plan.unmet.length, 0);
});

test('planZolanaRebalance: not enough donors → unmet, the rich one is not drained below the floor', () => {
  const rng = () => 0;
  const plan = planZolanaRebalance([
    { name: 'rich', address: 'R1', zolana: 14_000 },   // avail only 500
    { name: 'poor1', address: 'P1', zolana: 5_000 },   // need 7000
  ], { rng });
  assert.equal(plan.transfers.length, 1);
  assert.equal(plan.transfers[0].amount, 500, 'a donor gives only the surplus above the floor');
  assert.equal(plan.unmet.length, 1);
  assert.ok(plan.unmet[0].short >= 6500);
});

test('planZolanaRebalance: all ≥ threshold → empty plan; never transfers to itself', () => {
  assert.equal(planZolanaRebalance([
    { name: 'a', address: 'A', zolana: 15000 }, { name: 'b', address: 'B', zolana: 11000 },
  ]).transfers.length, 0);
});

// "Makes sense to sell" gate (2026-07-06): only fund short accounts that have something to list.
test('planZolanaRebalance: gate funds short accounts WITH sellable pets, skips empty ones', () => {
  const rng = () => 0;
  const plan = planZolanaRebalance([
    { name: 'rich', address: 'R1', zolana: 30_000 },   // donor, avail 16500
    { name: 'seller', address: 'S1', zolana: 8_000 },  // short + has pets → funded
    { name: 'empty', address: 'E1', zolana: 8_000 },   // short + nothing to sell → skipped
  ], {
    rng,
    sellableByName: { seller: { pets: 5, gold: 0 }, empty: { pets: 0, gold: 0 } },
  });
  assert.deepEqual(plan.transfers.map(t => t.to), ['seller'], 'only the account with pets is funded');
  assert.deepEqual(plan.skipped.map(s => s.name), ['empty'], 'the empty account is skipped with a reason');
  assert.ok(plan.skipped[0].reason.includes('nothing to sell'));
});

test('planZolanaRebalance: gate also funds a short account sitting on a Gold pile (no pets)', () => {
  const plan = planZolanaRebalance([
    { name: 'rich', address: 'R1', zolana: 30_000 },
    { name: 'goldbag', address: 'G1', zolana: 9_000 }, // no pets but 400k gold → funded
  ], {
    rng: () => 0,
    sellableByName: { goldbag: { pets: 0, gold: 400_000 } },
    minSellableGold: 100_000,
  });
  assert.deepEqual(plan.transfers.map(t => t.to), ['goldbag']);
  assert.equal(plan.skipped.length, 0);
});

test('planZolanaRebalance: no sellableByName → gate OFF (backward compatible, funds all short)', () => {
  const plan = planZolanaRebalance([
    { name: 'rich', address: 'R1', zolana: 30_000 },
    { name: 'unknown', address: 'U1', zolana: 8_000 }, // no inventory data → still funded
  ], { rng: () => 0 });
  assert.deepEqual(plan.transfers.map(t => t.to), ['unknown']);
  assert.equal(plan.skipped.length, 0);
});
