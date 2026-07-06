// Persists the history of the creature market floor (by rarity) + the $ZOLANA/USD price from Jupiter —
// feeds the interactive candlestick charts on the dashboard (2026-07-06, owner: "a chart per rarity,
// like on TradingView, candles, 1m/3m/5m modes, floor in dollars and tokens").
//
// Data sources (already existing — this is NOT new API traffic, except the separate Jupiter poller):
//   1) Floor by rarity — each of the 18 bots already reads /api/market/recent-sales every ~10 min
//      (creatureFloorZolanaByRarity in marketplace.js). Previously the result lived ONLY in the bot's
//      memory (this.creatureFloorZolana) and was lost on restart. Now each bot ADDITIONALLY writes what
//      it read to disk — one file per account (like ledger-<name>.jsonl) so 18 processes never write to
//      one file concurrently. On read the dashboard MERGES all files into one time series — thanks to
//      the jitter spread between accounts the aggregated sampling frequency ends up noticeably higher
//      than the 10 min of any single bot, with no extra load.
//   2) $ZOLANA/USD price — a SEPARATE series, its own file, written ONLY by the dashboard server (see
//      serve-dashboard.js) via the open Jupiter Price API v3 (keyless, no key, 0.5 RPS limit — our
//      once-a-minute poll is well within it). This is a source of the rate INDEPENDENT of the game — the
//      game already confused the owner with a low/stale number earlier in this same session.
//
// The USD floor price is computed on READ, not on write: floorZolana (the raw value in tokens) is stored
// separately from the rate, and every read converts it at the NEAREST-IN-TIME rate (nearestPriceAt),
// not today's — otherwise the historical USD candles would retroactively distort on every rate swing
// (the rate has already dropped 30%+ in 24h in this session).

import { appendFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_DIR = join(__dirname, '..', 'logs');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── floor-by-rarity: write (one file per account) ──
// goldFloorUsd (optional, 2026-07-06): the current external Gold→USD market rate, alongside the same
// point — feeds estimateProfitUsd (ledger.js) for the blended "Profit today". Not a separate poll:
// bot.js calls getGoldFloorUsd() in the SAME throttled block that already reads the floor by rarity.
// clearing (optional, 2026-07-06): per-rarity MEDIAN sale price in ZOLANA — the stable "price it actually
// sells at". The chart plots this, not the raw min-floor, because the min whipsaws 15× on a thin market.
export function appendFloorSnapshot(account, floors, counts = {}, { logDir = DEFAULT_LOG_DIR, now = Date.now(), goldFloorUsd = null, clearing = null } = {}) {
  const hasFloors = floors && Object.keys(floors).length > 0;
  const hasGoldFloor = Number.isFinite(goldFloorUsd) && goldFloorUsd > 0;
  const hasClearing = clearing && Object.keys(clearing).length > 0;
  // IMPORTANT: don't require hasFloors — a thin market often returns an EMPTY floors-by-rarity (no fresh
  // creature sales at any rarity this tick), but goldFloorUsd may have come separately and successfully;
  // previously this condition would drop a valid gold read just because floors happened to be empty.
  if (!account || (!hasFloors && !hasGoldFloor && !hasClearing)) return;
  ensureDir(logDir);
  const record = { ts: new Date(now).toISOString(), floors: hasFloors ? floors : {}, counts };
  if (hasClearing) record.clearing = clearing;
  if (hasGoldFloor) record.goldFloorUsd = goldFloorUsd;
  appendFileSync(join(logDir, `floor-history-${account}.jsonl`), JSON.stringify(record) + '\n');
}

// The last known Gold→USD rate across ALL accounts (not a series — "Profit today" only needs the current
// point, unlike floor-by-rarity, which needs the whole history for candles).
export function latestGoldFloorUsd({ logDir = DEFAULT_LOG_DIR } = {}) {
  if (!existsSync(logDir)) return null;
  let best = null;
  for (const f of readdirSync(logDir)) {
    if (!/^floor-history-.*\.jsonl$/.test(f)) continue;
    let raw;
    try { raw = readFileSync(join(logDir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const t = Date.parse(e?.ts);
      const v = Number(e?.goldFloorUsd);
      if (!Number.isFinite(t) || !(v > 0)) continue;
      if (!best || t > best.ts) best = { ts: t, value: v };
    }
  }
  return best ? best.value : null;
}

// ── floor-by-rarity: read (merges ALL floor-history-*.jsonl into one time-ordered series) ──
// Returns [{ ts:number(ms), rarity:string, floorZolana:number, saleCount:number }], sorted.
export function readFloorHistory({ logDir = DEFAULT_LOG_DIR, sinceMs = 0 } = {}) {
  if (!existsSync(logDir)) return [];
  const out = [];
  for (const f of readdirSync(logDir)) {
    if (!/^floor-history-.*\.jsonl$/.test(f)) continue;
    let raw;
    try { raw = readFileSync(join(logDir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const t = Date.parse(e?.ts);
      if (!Number.isFinite(t) || t < sinceMs) continue;
      // Emit a point per rarity that has EITHER a floor or a clearing reading this snapshot. clearingZolana
      // (median) is the chart's preferred value; floorZolana (min) is the fallback for old snapshots.
      const rarities = new Set([...Object.keys(e.floors || {}), ...Object.keys(e.clearing || {})]);
      for (const rarity of rarities) {
        const z = Number(e.floors?.[rarity]);
        const c = Number(e.clearing?.[rarity]);
        const floorZolana = z > 0 ? z : 0;
        const clearingZolana = c > 0 ? c : 0;
        if (!(floorZolana > 0) && !(clearingZolana > 0)) continue;
        out.push({ ts: t, rarity, floorZolana, clearingZolana, saleCount: Number(e.counts?.[rarity]) || 0 });
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ── $ZOLANA/USD rate (Jupiter): write — only ever called from serve-dashboard.js ──
export function appendJupiterPrice(usdPrice, { logDir = DEFAULT_LOG_DIR, now = Date.now() } = {}) {
  const price = Number(usdPrice);
  if (!(price > 0)) return;
  ensureDir(logDir);
  const line = JSON.stringify({ ts: new Date(now).toISOString(), usdPrice: price }) + '\n';
  appendFileSync(join(logDir, 'jupiter-price-history.jsonl'), line);
}

// ── $ZOLANA/USD rate: read ──
export function readJupiterPriceHistory({ logDir = DEFAULT_LOG_DIR, sinceMs = 0 } = {}) {
  const p = join(logDir, 'jupiter-price-history.jsonl');
  if (!existsSync(p)) return [];
  let raw; try { raw = readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e?.ts);
    const price = Number(e?.usdPrice);
    if (!Number.isFinite(t) || t < sinceMs || !(price > 0)) continue;
    out.push({ ts: t, usdPrice: price });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Nearest-in-time rate point to ts (priceHistory must be sorted by ts — as readJupiterPriceHistory
// returns). null if the history is empty. Binary search — the history can accumulate many points over
// days of running, and a linear scan per candle would be wasteful.
export function nearestPriceAt(priceHistory, ts) {
  if (!priceHistory || !priceHistory.length) return null;
  const n = priceHistory.length;
  if (ts <= priceHistory[0].ts) return priceHistory[0].usdPrice;
  if (ts >= priceHistory[n - 1].ts) return priceHistory[n - 1].usdPrice;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (priceHistory[mid].ts <= ts) lo = mid; else hi = mid;
  }
  const dLo = ts - priceHistory[lo].ts, dHi = priceHistory[hi].ts - ts;
  return dLo <= dHi ? priceHistory[lo].usdPrice : priceHistory[hi].usdPrice;
}

// Split a {ts, value}[] time series into fixed-width OHLC candles (timeframeMs). Empty buckets (no reads
// at all — thin market, not every account reported, etc.) are filled with a flat candle at the previous
// close rather than skipped — otherwise the chart would read as "the price vanished" when really "there
// was no new data this window, the price didn't move." Before the first real read there are no candles
// at all (nothing to carry a close from).
export function buildCandles(readings, { timeframeMs, startMs, endMs = Date.now() } = {}) {
  if (!(timeframeMs > 0)) return [];
  const sorted = (readings || [])
    .filter((r) => Number.isFinite(r?.ts) && Number.isFinite(r?.value))
    .sort((a, b) => a.ts - b.ts);
  if (!sorted.length) return [];
  const first = startMs != null ? startMs : sorted[0].ts;
  const bucketStart = (ts) => Math.floor(ts / timeframeMs) * timeframeMs;
  const candles = [];
  let idx = 0;
  let prevClose = null;
  for (let t = bucketStart(first); t <= endMs; t += timeframeMs) {
    const inBucket = [];
    while (idx < sorted.length && sorted[idx].ts < t + timeframeMs) {
      if (sorted[idx].ts >= t) inBucket.push(sorted[idx]);
      idx++;
    }
    if (inBucket.length) {
      const values = inBucket.map((r) => r.value);
      const open = prevClose != null ? prevClose : values[0];
      const close = values[values.length - 1];
      const volume = inBucket.reduce((s, r) => s + (Number(r.saleCount) || 0), 0);
      candles.push({ time: Math.floor(t / 1000), open, high: Math.max(open, ...values), low: Math.min(open, ...values), close, volume });
      prevClose = close;
    } else if (prevClose != null) {
      candles.push({ time: Math.floor(t / 1000), open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
    }
  }
  return candles;
}

// Build candles for ONE rarity in both units at once — ZOLANA (raw, from floorHistory) and USD
// (floorZolana × the nearest-in-time Jupiter rate at each read). unit='usd'|'zolana' picks what to
// build; for 'usd', points without a rate (the rate has never been sampled yet) are dropped — we don't
// invent a rate out of thin air.
export function buildRarityCandles(floorHistory, priceHistory, rarity, { timeframeMs, unit = 'zolana', startMs, endMs } = {}) {
  const points = (floorHistory || []).filter((r) => r.rarity === rarity);
  const readings = unit === 'usd'
    ? points.map((r) => {
      const price = nearestPriceAt(priceHistory, r.ts);
      return price == null ? null : { ts: r.ts, value: r.floorZolana * price, saleCount: r.saleCount };
    }).filter(Boolean)
    : points.map((r) => ({ ts: r.ts, value: r.floorZolana, saleCount: r.saleCount }));
  return buildCandles(readings, { timeframeMs, startMs, endMs });
}
