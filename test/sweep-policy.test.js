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

// ── ZOLANA CONSOLIDATION 2026-07-06 (owner: "concentrate $ZOLANA onto accounts with pets to sell so their
// market opens — >10k, fund to >12k; the old spread-evenly design never moved anything since 0 donors").
import { planZolanaRebalance } from '../src/zolana-rebalance.js';

const net = (plan) => { const m = {}; for (const t of plan.transfers) { m[t.from] = (m[t.from] || 0) - t.amount; m[t.to] = (m[t.to] || 0) + t.amount; } return m; };

test('consolidation: drains a non-seller to fund a sellable account up to target', () => {
  const plan = planZolanaRebalance([
    { name: 'idle', address: 'I1', zolana: 20_000 },   // no sellable pets → its idle $ZOLANA is redistributed
    { name: 'seller', address: 'S1', zolana: 8_000 },  // has pets, below target → funded toward 12k
  ], { rng: () => 0.5, sellableByName: { idle: { pets: 0, gold: 0 }, seller: { pets: 5, gold: 0 } } });
  assert.deepEqual(plan.funded, ['seller'], 'the sellable account is funded; the idle one never is');
  assert.ok(plan.transfers.length >= 1 && plan.transfers.every(t => t.from === 'idle' && t.to === 'seller'));
  const got = plan.transfers.reduce((s, t) => s + t.amount, 0);
  assert.ok(got >= 4000 && got <= 4600, `seller reaches ~12k (8k + ~4k, got +${got})`);
  assert.ok(20_000 - got >= 1_000, 'the idle donor keeps at least the op-reserve, not fully drained when unneeded');
});

test('consolidation conserves $ZOLANA (every transfer nets to zero) and never over-funds', () => {
  const plan = planZolanaRebalance([
    { name: 'a', address: 'A', zolana: 15_000 }, { name: 'b', address: 'B', zolana: 9_000 },
    { name: 'c', address: 'C', zolana: 6_000 }, { name: 'd', address: 'D', zolana: 3_000 },
  ], { rng: () => 0.5, sellableByName: { a: { pets: 0 }, b: { pets: 5 }, c: { pets: 5 }, d: { pets: 5 } } });
  const flow = net(plan);
  assert.equal(Object.values(flow).reduce((s, v) => s + v, 0), 0, 'transfers conserve $ZOLANA');
  // no recipient ends above target+buffer (no over-funding)
  for (const acc of [{ n: 'b', z: 9_000 }, { n: 'c', z: 6_000 }, { n: 'd', z: 3_000 }]) {
    assert.ok(acc.z + (flow[acc.n] || 0) <= 12_600, `${acc.n} not over-funded past ~target`);
  }
});

test('consolidation: fleet too short to fund all → funds the closest-to-target seller, drains the poorest', () => {
  // total 24k, opReserve 1k×4 → budget 20k; target 12k needs ~11k each → only ~1 seller fully funded
  const plan = planZolanaRebalance([
    { name: 's1', address: 'A', zolana: 10_000 }, // closest to target → funded first, market opens
    { name: 's2', address: 'B', zolana: 7_000 },
    { name: 's3', address: 'C', zolana: 4_000 },  // poorest → drained toward op-reserve to fund s1
    { name: 's4', address: 'D', zolana: 3_000 },
  ], { rng: () => 0, sellableByName: { s1: { pets: 5 }, s2: { pets: 5 }, s3: { pets: 5 }, s4: { pets: 5 } } });
  assert.deepEqual(plan.funded, ['s1'], 's1 (highest balance = cheapest to cross) is funded');
  const flow = net(plan);
  assert.equal(10_000 + (flow.s1 || 0), 12_000, 's1 reaches target 12k (rng=0 → no jitter)');
  assert.ok((flow.s3 || 0) < 0 && (flow.s4 || 0) < 0, 'the poorest accounts donate (drained toward reserve)');
  assert.ok(plan.skipped.some(s => s.name === 's4'), 's4 is skipped this cycle (fleet too short)');
});

test('consolidation: a non-seller is NEVER funded (its idle $ZOLANA only ever donates)', () => {
  const plan = planZolanaRebalance([
    { name: 'seller', address: 'S1', zolana: 11_000 },
    { name: 'empty', address: 'E1', zolana: 2_000 }, // no pets, below target — but NOT a recipient
  ], { rng: () => 0, sellableByName: { seller: { pets: 5 }, empty: { pets: 0, gold: 0 } } });
  assert.equal(plan.recipients.includes('empty'), false, 'empty (no pets) is never a recipient');
  assert.deepEqual(plan.funded, ['seller']);
  // empty at 2000 > opReserve 1000 → it donates 1000 to help fund the seller
  assert.ok(plan.transfers.every(t => t.to === 'seller'));
});

test('consolidation: a Gold-pile account counts as sellable (funded)', () => {
  const plan = planZolanaRebalance([
    { name: 'idle', address: 'I1', zolana: 20_000 },
    { name: 'goldbag', address: 'G1', zolana: 9_000 }, // no pets but 400k gold → sellable → funded
  ], { rng: () => 0, sellableByName: { idle: { pets: 0, gold: 0 }, goldbag: { pets: 0, gold: 400_000 } }, minSellableGold: 100_000 });
  assert.deepEqual(plan.funded, ['goldbag']);
});

test('consolidation: no sellableByName → every account is fundable (back-compat gate off)', () => {
  const plan = planZolanaRebalance([
    { name: 'a', address: 'A', zolana: 20_000 },
    { name: 'b', address: 'B', zolana: 8_000 },
  ], { rng: () => 0 });
  assert.ok(plan.funded.includes('a') || plan.funded.includes('b'), 'accounts are funded without inventory data');
});
