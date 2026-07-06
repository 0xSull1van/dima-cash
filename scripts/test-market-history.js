// Tests for src/market-history.js — floor/price time-series persistence + OHLC candle bucketing
// (no network). Mirrors the scripts/test-ledger.js pattern: real filesystem, isolated temp log dir.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendFloorSnapshot, readFloorHistory, appendJupiterPrice, readJupiterPriceHistory,
  nearestPriceAt, buildCandles, buildRarityCandles, latestGoldFloorUsd,
} from '../src/market-history.js';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL:', message); }
};

const logDir = join(process.cwd(), 'logs-test-market-history');
rmSync(logDir, { recursive: true, force: true });

// ── floor snapshots: write + read round-trip, multi-account merge ──
const T0 = Date.parse('2026-07-06T10:00:00Z');
appendFloorSnapshot('main', { uncommon: 100, rare: 500 }, { uncommon: 2, rare: 1 }, { logDir, now: T0 });
appendFloorSnapshot('spare', { uncommon: 95, epic: 2000 }, { uncommon: 1 }, { logDir, now: T0 + 30_000 });
appendFloorSnapshot('main', { uncommon: 110 }, {}, { logDir, now: T0 + 60_000 });

const hist = readFloorHistory({ logDir });
ok(hist.length === 5, `merges both accounts' files into one series (5 rarity-readings total, got ${hist.length})`);
ok(hist.every((r, i) => i === 0 || r.ts >= hist[i - 1].ts), 'sorted by ts ascending across files');
ok(hist.find(r => r.rarity === 'rare')?.floorZolana === 500, 'rare reading present');
ok(hist.find(r => r.rarity === 'epic')?.saleCount === 0, 'saleCount defaults to 0 when not in counts');
ok(hist.filter(r => r.rarity === 'uncommon').length === 3, `3 uncommon readings across both accounts+time (got ${hist.filter(r => r.rarity === 'uncommon').length})`);

// no writes at all → empty, doesn't throw
ok(readFloorHistory({ logDir: join(logDir, 'nonexistent') }).length === 0, 'missing logDir → empty array, not a throw');

// sinceMs filters correctly
ok(readFloorHistory({ logDir, sinceMs: T0 + 60_000 }).length === 1, 'sinceMs excludes earlier readings');

// zero/negative floor values are dropped, not passed through as garbage
appendFloorSnapshot('weird', { common: 0, rare: -5, epic: 300 }, {}, { logDir, now: T0 + 90_000 });
const histAfterWeird = readFloorHistory({ logDir });
ok(!histAfterWeird.some(r => r.floorZolana <= 0), 'zero/negative floor readings are filtered out, not stored as-is');

// appendFloorSnapshot silently no-ops on empty/missing floors (nothing worth writing)
const callsBefore = readFloorHistory({ logDir }).length;
appendFloorSnapshot('nobody', {}, {}, { logDir, now: T0 });
appendFloorSnapshot(null, { common: 1 }, {}, { logDir, now: T0 });
ok(readFloorHistory({ logDir }).length === callsBefore, 'empty floors / missing account name → no-op, does not write garbage');

// ── latestGoldFloorUsd (2026-07-06, feeds estimateProfitUsd's Gold→USD conversion) ──
ok(latestGoldFloorUsd({ logDir: join(logDir, 'nonexistent') }) === null, 'missing logDir → null, not a throw');
ok(latestGoldFloorUsd({ logDir }) === null, 'no snapshot has ever carried a goldFloorUsd yet → null (none invented)');
appendFloorSnapshot('main', { uncommon: 100 }, {}, { logDir, now: T0 + 100_000, goldFloorUsd: 0.0000012 });
appendFloorSnapshot('spare', { uncommon: 90 }, {}, { logDir, now: T0 + 200_000, goldFloorUsd: 0.0000015 }); // newer + different account
appendFloorSnapshot('main', { uncommon: 95 }, {}, { logDir, now: T0 + 50_000 }); // older, no goldFloorUsd at all — must not overwrite
ok(latestGoldFloorUsd({ logDir }) === 0.0000015, `picks the NEWEST goldFloorUsd across all accounts' files, not just one account's (got ${latestGoldFloorUsd({ logDir })})`);
appendFloorSnapshot('main', { uncommon: 105 }, {}, { logDir, now: T0 - 1_000_000, goldFloorUsd: 99 }); // older ts, higher value — must lose on recency, not magnitude
ok(latestGoldFloorUsd({ logDir }) === 0.0000015, 'recency wins over magnitude — an older reading never overrides a newer one regardless of its value');

// REGRESSION: an EMPTY creature-floor reading (thin market, no rarity had a recent sale this tick)
// must NOT drop a perfectly valid goldFloorUsd that came in alongside it — caught before shipping.
{
  const soloDir = join(logDir, 'gold-only');
  appendFloorSnapshot('onlygold', {}, {}, { logDir: soloDir, now: T0, goldFloorUsd: 0.000004 });
  ok(latestGoldFloorUsd({ logDir: soloDir }) === 0.000004,
    'empty floors object does not suppress a valid goldFloorUsd reading from being written');
  ok(readFloorHistory({ logDir: soloDir }).length === 0,
    'that same record correctly contributes zero rarity-floor rows (floors really was empty)');
}

// ── Jupiter price history: round-trip, filtering, ordering ──
appendJupiterPrice(0.0003, { logDir, now: T0 });
appendJupiterPrice(0.00035, { logDir, now: T0 + 60_000 });
appendJupiterPrice(-1, { logDir, now: T0 + 90_000 }); // invalid — must be dropped
appendJupiterPrice(0, { logDir, now: T0 + 90_000 });  // invalid — must be dropped
const prices = readJupiterPriceHistory({ logDir });
ok(prices.length === 2, `invalid (<=0) prices are rejected at write time (got ${prices.length})`);
ok(prices[0].usdPrice === 0.0003 && prices[1].usdPrice === 0.00035, 'sorted ascending by ts');

// ── nearestPriceAt: exact/before/after/tie-break, empty history ──
ok(nearestPriceAt(prices, T0) === 0.0003, 'exact match at first point');
ok(nearestPriceAt(prices, T0 - 1_000_000) === 0.0003, 'before the whole series clamps to the first point');
ok(nearestPriceAt(prices, T0 + 1_000_000) === 0.00035, 'after the whole series clamps to the last point');
ok(nearestPriceAt(prices, T0 + 20_000) === 0.0003, 'closer to the first point (20s in of a 60s gap)');
ok(nearestPriceAt(prices, T0 + 40_000) === 0.00035, 'closer to the second point (40s in of a 60s gap)');
ok(nearestPriceAt([], 123) === null, 'empty history → null, not a throw');

// ── buildCandles: OHLC bucketing, gap carry-forward, edge cases ──
ok(buildCandles([], { timeframeMs: 60_000 }).length === 0, 'empty input → no candles');
ok(buildCandles([{ ts: T0, value: 5 }], { timeframeMs: 0 }).length === 0, 'timeframeMs<=0 → no candles (invalid config, not a crash)');

{
  // one 60s bucket with 3 readings: open=first(prevClose is null→first value), high=max, low=min, close=last
  const readings = [
    { ts: T0 + 0, value: 100 },
    { ts: T0 + 20_000, value: 120 },
    { ts: T0 + 40_000, value: 90 },
  ];
  const candles = buildCandles(readings, { timeframeMs: 60_000, startMs: T0, endMs: T0 + 59_000 });
  ok(candles.length === 1, `single bucket for readings all within 60s (got ${candles.length})`);
  const c = candles[0];
  ok(c.open === 100 && c.high === 120 && c.low === 90 && c.close === 90,
    `OHLC computed correctly (got ${JSON.stringify(c)})`);
  ok(c.time === Math.floor(T0 / 1000), 'time is unix seconds, not ms (lightweight-charts convention)');
}

{
  // a real reading, then a gap bucket, then another real reading — gap must carry the previous close
  // forward as a flat candle, not be skipped (a skip would read on the chart as "price vanished").
  const readings = [
    { ts: T0, value: 50 },
    { ts: T0 + 120_000, value: 70 }, // 2 buckets later (60s timeframe) — bucket 1 (T0+60_000) is empty
  ];
  const candles = buildCandles(readings, { timeframeMs: 60_000, startMs: T0, endMs: T0 + 120_000 });
  ok(candles.length === 3, `3 buckets: real, gap-filled, real (got ${candles.length})`);
  ok(candles[0].close === 50, 'first candle closes at the real reading');
  ok(candles[1].open === 50 && candles[1].high === 50 && candles[1].low === 50 && candles[1].close === 50,
    `gap bucket is a flat doji at the previous close (got ${JSON.stringify(candles[1])})`);
  ok(candles[2].open === 50 && candles[2].close === 70, 'next real bucket opens at prior close, closes at its own reading');
}

{
  // no candles emitted before the FIRST real reading — nothing to carry forward from yet
  const readings = [{ ts: T0 + 180_000, value: 42 }];
  const candles = buildCandles(readings, { timeframeMs: 60_000, startMs: T0, endMs: T0 + 180_000 });
  ok(candles.length === 1, `only the bucket containing the first real reading — no phantom candles before it (got ${candles.length})`);
}

{
  // volume sums saleCount across all readings that land in the same bucket
  const readings = [
    { ts: T0, value: 10, saleCount: 2 },
    { ts: T0 + 10_000, value: 12, saleCount: 3 },
  ];
  const candles = buildCandles(readings, { timeframeMs: 60_000, startMs: T0, endMs: T0 + 59_000 });
  ok(candles[0].volume === 5, `volume sums saleCount within the bucket (got ${candles[0].volume})`);
}

// ── buildRarityCandles: combines floor history + price history, zolana vs usd unit ──
{
  const floorHist = [
    { ts: T0, rarity: 'rare', floorZolana: 1000, saleCount: 1 },
    { ts: T0 + 30_000, rarity: 'rare', floorZolana: 1200, saleCount: 0 },
    { ts: T0, rarity: 'epic', floorZolana: 5000, saleCount: 0 }, // different rarity — must be excluded from 'rare' candles
  ];
  const priceHist = [{ ts: T0, usdPrice: 0.001 }];

  const zolanaCandles = buildRarityCandles(floorHist, priceHist, 'rare', { timeframeMs: 60_000, startMs: T0, endMs: T0 + 30_000 });
  ok(zolanaCandles.length === 1 && zolanaCandles[0].close === 1200, `zolana unit uses raw floorZolana values, filtered to 'rare' only (got ${JSON.stringify(zolanaCandles)})`);

  const usdCandles = buildRarityCandles(floorHist, priceHist, 'rare', { timeframeMs: 60_000, unit: 'usd', startMs: T0, endMs: T0 + 30_000 });
  ok(Math.abs(usdCandles[0].close - 1.2) < 1e-9, `usd unit converts via nearest price (1200 × 0.001 = 1.2), got ${usdCandles[0]?.close}`);

  // no price history at all for 'usd' → every point is dropped (never invent a conversion rate)
  const usdNoPricing = buildRarityCandles(floorHist, [], 'rare', { timeframeMs: 60_000, unit: 'usd', startMs: T0, endMs: T0 + 30_000 });
  ok(usdNoPricing.length === 0, 'usd unit with zero price history → no candles, not a fabricated conversion');
}

rmSync(logDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
