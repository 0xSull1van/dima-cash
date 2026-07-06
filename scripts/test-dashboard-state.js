import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLedgerEvent } from '../src/ledger.js';
import { appendFloorSnapshot, appendJupiterPrice } from '../src/market-history.js';
import { collectState, collectMarketHistory } from './serve-dashboard.js';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL:', message); }
};

const logDir = join(process.cwd(), 'logs-test-dashboard');
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });
const now = Date.parse('2026-07-04T12:00:00.000Z');

writeFileSync(join(logDir, 'live-main.json'), JSON.stringify({
  name: 'main',
  address: 'Main111111111111111111111111111111111111',
  ts: 1000,
  priceUsd: 0.01,
  player: { gold: 70000, gems: 4, level: 3, stamina: 120, zenko_balance: 1000 },
  counts: { creatures: 22, placed: 8, eggs: 1, runs: 2, mats: 0 },
  goldHistory: [{ t: 1, gold: 1000 }, { t: 2, gold: 70000 }],
  log: [],
}), 'utf8');

writeFileSync(join(logDir, 'live-spare.json'), JSON.stringify({
  name: 'spare',
  address: 'Spare11111111111111111111111111111111111',
  ts: 2000,
  priceUsd: 0.01,
  player: { gold: 5000, gems: 1, level: 1, stamina: 30, zenko_balance: 500 },
  counts: { creatures: 5, placed: 3, eggs: 0, runs: 1, mats: 0 },
  goldHistory: [],
  log: [],
}), 'utf8');

appendLedgerEvent('main', {
  type: 'stamina_refill',
  ts: new Date(now - 20 * 60 * 1000).toISOString(),
  amounts: { zolana: -50 },
  tx: 'sig-main',
}, { logDir });
appendLedgerEvent('main', { type: 'egg_buy', ts: new Date(now - 15 * 60 * 1000).toISOString(), amounts: { gold: -50000 }, ref: { eggType: 'forest' } }, { logDir });
appendLedgerEvent('main', { type: 'dungeon_claim', ts: new Date(now - 15 * 60 * 1000).toISOString(), amounts: { gold: 70000 }, ref: { runId: 'r1' } }, { logDir });
appendLedgerEvent('main', {
  type: 'market_sale',
  ts: new Date(now - 30 * 60 * 1000).toISOString(),
  amounts: { zolana: 800 },
  tx: 'sig-sale',
}, { logDir });
appendLedgerEvent('main', {
  type: 'market_list',
  ts: new Date(now - 10 * 60 * 1000).toISOString(),
  ref: { listingId: 'open-creature', itemKind: 'creature' },
  meta: { priceUsd: 2.5 },
}, { logDir });
appendLedgerEvent('spare', {
  type: 'stamina_refill',
  ts: new Date(now - 40 * 60 * 1000).toISOString(),
  amounts: { zolana: -50 },
  tx: 'sig-spare',
}, { logDir });
// flywheel-activity events (recycle/unplace/vault/forge/hatch) — feed the dashboard's activity strip
appendLedgerEvent('main', { type: 'egg_hatch', ts: new Date(now - 5 * 60 * 1000).toISOString(), ref: { eggId: 'e1' } }, { logDir });
appendLedgerEvent('main', { type: 'egg_hatch', ts: new Date(now - 4 * 60 * 1000).toISOString(), ref: { eggId: 'e2' } }, { logDir });
appendLedgerEvent('main', { type: 'creature_unplace', ts: new Date(now - 6 * 60 * 1000).toISOString(), ref: { count: 3 } }, { logDir });
appendLedgerEvent('main', { type: 'creature_sacrifice', ts: new Date(now - 7 * 60 * 1000).toISOString(), ref: { targetId: 't1', count: 2 } }, { logDir });
appendLedgerEvent('spare', { type: 'creature_vault', ts: new Date(now - 8 * 60 * 1000).toISOString(), ref: { creatureId: 'v1' } }, { logDir });
appendLedgerEvent('spare', { type: 'creature_unvault', ts: new Date(now - 9 * 60 * 1000).toISOString(), ref: { creatureId: 'v1' } }, { logDir }); // vault↔fleet swap (2026-07-05)
appendLedgerEvent('spare', { type: 'breed', ts: new Date(now - 90 * 60 * 1000).toISOString(), amounts: { gold: -10000 }, ref: { species: 'fox' } }, { logDir }); // outside 1h window

// "Профит сегодня" (2026-07-06) needs a live Gold→USD floor + a Jupiter ZOLANA→USD price to blend with.
appendFloorSnapshot('main', { uncommon: 100 }, {}, { logDir, now: now - 5 * 60 * 1000, goldFloorUsd: 0.000002 });
appendJupiterPrice(0.0003, { logDir, now: now - 5 * 60 * 1000 });

// Isolate the registry: this test exercises live-file + ledger aggregation only,
// so point at a non-existent registry (loadRegistry → empty) instead of the real
// accounts.json, which would otherwise inject all registered wallets.
const state = collectState({ logDir, registryPath: join(logDir, 'no-registry.json'), now });
const main = state.accounts.find(a => a.name === 'main');
const spare = state.accounts.find(a => a.name === 'spare');

ok(state.accounts.length === 2, `reads live accounts (${state.accounts.length})`);
ok(state.price === 0.01, `uses live ZOLANA price (${state.price})`);
ok(state.totalUsd === 15, `computes holdings value (${state.totalUsd})`);
ok(main?.analytics?.realized?.spendZolana === 50, `main spendZolana ${main?.analytics?.realized?.spendZolana}`);
ok(main?.analytics?.realized?.revenueZolana === 800, `main revenueZolana ${main?.analytics?.realized?.revenueZolana}`);
ok(main?.analytics?.performance?.roiPct === 1500, `main roiPct ${main?.analytics?.performance?.roiPct}`);
ok(main?.analytics?.performance?.paidBack === true, 'main is paid back');
ok(main?.analytics?.inGame?.goldNet === 20000, `main goldNet ${main?.analytics?.inGame?.goldNet}`);
ok(spare?.analytics?.performance?.remainingZolana === 50, `spare remaining ${spare?.analytics?.performance?.remainingZolana}`);
ok(state.totalAnalytics?.realized?.pnlZolana === 700, `total pnl ${state.totalAnalytics?.realized?.pnlZolana}`);
ok(state.totalAnalytics?.performance?.paybackPct === 800, `total payback ${state.totalAnalytics?.performance?.paybackPct}`);
ok(main?.analytics?.zolanaWindows?.h1?.netPerHour === 750, `main 1h net/h ${main?.analytics?.zolanaWindows?.h1?.netPerHour}`);
ok(state.totalAnalytics?.zolanaWindows?.h1?.netZolana === 700, `fleet 1h net ${state.totalAnalytics?.zolanaWindows?.h1?.netZolana}`);
// gross Gold earned/hour ("весь заработок" — spending NOT subtracted; from dungeon_claim income)
ok(main?.analytics?.goldWindows?.h1?.grossGold === 70000, `main 1h gross gold ${main?.analytics?.goldWindows?.h1?.grossGold}`);
ok(main?.analytics?.goldWindows?.h1?.grossPerHour === 70000, `main 1h gross gold/h ${main?.analytics?.goldWindows?.h1?.grossPerHour}`);
ok(main?.analytics?.goldWindows?.h1?.netGold === 20000, `main 1h net gold ${main?.analytics?.goldWindows?.h1?.netGold}`);
ok(state.totalAnalytics?.goldWindows?.h1?.grossPerHour === 70000, `fleet 1h gross gold/h ${state.totalAnalytics?.goldWindows?.h1?.grossPerHour}`);

// "Профит сегодня" (profitUsd24h, 2026-07-06): main gross gold(h24)=70000 × goldFloorUsd(0.000002) +
// net zolana(h24)=750 (800 sale − 50 refill) × jupiterPrice(0.0003) = 0.14 + 0.225 = 0.365.
// Fleet: same gross gold (only main mined any) + net zolana 700 (750 main − 50 spare refill) = 0.35.
ok(Math.abs((main?.analytics?.profitUsd24h ?? NaN) - 0.365) < 1e-9, `main profitUsd24h ${main?.analytics?.profitUsd24h}`);
ok(Math.abs((state.totalAnalytics?.profitUsd24h ?? NaN) - 0.35) < 1e-9, `fleet profitUsd24h ${state.totalAnalytics?.profitUsd24h}`);
ok(state.jupiterPriceUsd === 0.0003, `live jupiter price surfaced on state (${state.jupiterPriceUsd})`);
ok(state.goldFloorUsd === 0.000002, `live gold floor surfaced on state (${state.goldFloorUsd})`);
// spare never had a live gold-floor/jupiter fixture of its own, but the rates are FLEET-WIDE
// (one market), so spare's own profitUsd24h must still compute using the shared rates.
ok(spare?.analytics?.profitUsd24h != null, `spare also gets a profitUsd24h using the shared fleet-wide rates (${spare?.analytics?.profitUsd24h})`);
ok(state.totalAnalytics?.market?.pendingUsd === 2.5, `fleet pending USD ${state.totalAnalytics?.market?.pendingUsd}`);
ok(state.totalAnalytics?.recent?.length === 13, `total recent events ${state.totalAnalytics?.recent?.length}`);
// flywheel activity strip: per-type counts within the 1h window (fleet-wide)
const act1h = state.totalAnalytics?.activityWindows?.h1 || {};
ok(act1h.egg_hatch === 2, `fleet 1h egg_hatch count ${act1h.egg_hatch}`);
ok(act1h.creature_unplace === 1, `fleet 1h creature_unplace count ${act1h.creature_unplace}`);
ok(act1h.creature_sacrifice === 1, `fleet 1h creature_sacrifice count ${act1h.creature_sacrifice}`);
ok(act1h.creature_vault === 1, `fleet 1h creature_vault count ${act1h.creature_vault}`);
ok(act1h.creature_unvault === 1, `fleet 1h creature_unvault count ${act1h.creature_unvault}`);
ok(act1h.breed === undefined, `breed 90min ago excluded from 1h window (got ${act1h.breed})`);
ok((state.totalAnalytics?.activityWindows?.h6 || {}).breed === 1, `breed 90min ago IS inside 6h window`);

// collectMarketHistory (2026-07-06): serves raw floor/price time-series for the candlestick chart,
// windowed by `hours` (default 24) rather than the whole file history. Note: the profitUsd24h fixture
// above (now-5min, uncommon:100, jupiter 0.0003) ALSO falls inside every window used here — accounted
// for in the expected counts below (it's the same shared floor-history-main.jsonl file).
appendFloorSnapshot('main', { uncommon: 300 }, { uncommon: 2 }, { logDir, now: now - 30 * 60 * 1000 }); // 30min ago — inside any window
appendFloorSnapshot('main', { uncommon: 250 }, { uncommon: 1 }, { logDir, now: now - 30 * 60 * 60 * 1000 }); // 30h ago — outside a 24h window
appendJupiterPrice(0.00031, { logDir, now: now - 30 * 60 * 1000 });
const mh = collectMarketHistory({ logDir, hours: 24, now });
ok(mh.floors.length === 2, `24h window excludes the 30h-old reading but keeps both recent ones (got ${mh.floors.length})`);
ok(mh.floors[0].floorZolana === 300, `oldest-of-the-recent reading sorts first (got ${mh.floors[0]?.floorZolana})`);
ok(mh.prices.length === 2 && mh.prices[0].usdPrice === 0.00031, `jupiter price series included, sorted ascending by time (got ${JSON.stringify(mh.prices)})`);
const mhWide = collectMarketHistory({ logDir, hours: 48, now });
ok(mhWide.floors.length === 3, `wider window (48h) includes the 30h-old reading too (got ${mhWide.floors.length})`);

rmSync(logDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
