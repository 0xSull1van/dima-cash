import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendLedgerEvent, readLedgerEvents, summarizeLedger, estimateProfitUsd } from '../src/ledger.js';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL:', message); }
};

const logDir = join(process.cwd(), 'logs-test-ledger');
rmSync(logDir, { recursive: true, force: true });

const spend = appendLedgerEvent('main', {
  type: 'stamina_refill',
  status: 'confirmed',
  amounts: { zolana: -50, gold: 0, gems: 0 },
  tx: 'sig1',
  ref: { dungeonId: 1 },
}, { logDir });

appendLedgerEvent('main', {
  type: 'market_sale',
  status: 'confirmed',
  amounts: { zolana: 800, gold: 0, gems: 0 },
  tx: 'sig2',
  ref: { itemId: 'creature-1' },
}, { logDir });

appendLedgerEvent('main', {
  type: 'egg_buy',
  status: 'confirmed',
  amounts: { zolana: 0, gold: -50000, gems: 0 },
  ref: { itemId: 'forest' },
}, { logDir });

appendLedgerEvent('main', {
  type: 'quest_claim',
  status: 'confirmed',
  amounts: { zolana: 0, gold: 2000, gems: 3 },
  ref: { itemId: 'd_place' },
}, { logDir });

const events = readLedgerEvents('main', { logDir });
const summary = summarizeLedger(events, 0.01);

ok(spend.id && spend.ts && spend.account === 'main', 'append returns normalized event identity');
ok(events.length === 4, `reads all events (${events.length})`);
ok(summary.realized.spendZolana === 50, `spendZolana is 50 (${summary.realized.spendZolana})`);
ok(summary.realized.revenueZolana === 800, `revenueZolana is 800 (${summary.realized.revenueZolana})`);
ok(summary.realized.pnlZolana === 750, `pnlZolana is 750 (${summary.realized.pnlZolana})`);
ok(summary.realized.pnlUsd === 7.5, `pnlUsd is 7.5 (${summary.realized.pnlUsd})`);
ok(summary.inGame.goldNet === -48000, `gold net is -48000 (${summary.inGame.goldNet})`);
ok(summary.inGame.gemsNet === 3, `gems net is 3 (${summary.inGame.gemsNet})`);
ok(summary.counts.byType.stamina_refill === 1 && summary.counts.byType.market_sale === 1, 'counts events by type');
ok(summary.recent.length === 4 && summary.recent[3].type === 'quest_claim', 'keeps recent events in order');

const now = Date.parse('2026-07-04T12:00:00.000Z');
const windowSummary = summarizeLedger([
  {
    account: 'main',
    type: 'market_sale',
    ts: new Date(now - 30 * 60 * 1000).toISOString(),
    amounts: { zolana: 120 },
    ref: { listingId: 'sale-1' },
    meta: { priceUsd: 1.2 },
  },
  {
    account: 'main',
    type: 'stamina_refill',
    ts: new Date(now - 15 * 60 * 1000).toISOString(),
    amounts: { zolana: -20 },
  },
  {
    account: 'main',
    type: 'market_sale',
    ts: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    amounts: { zolana: 60 },
    ref: { listingId: 'sale-2' },
    meta: { priceUsd: 0.6 },
  },
  {
    account: 'main',
    type: 'market_sale',
    ts: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
    amounts: { zolana: 240 },
    ref: { listingId: 'sale-3' },
    meta: { priceUsd: 2.4 },
  },
  {
    account: 'main',
    type: 'market_list',
    ts: new Date(now - 10 * 60 * 1000).toISOString(),
    ref: { listingId: 'open-creature', itemKind: 'creature' },
    meta: { priceUsd: 2.5 },
  },
  {
    account: 'main',
    type: 'market_sync',
    ts: new Date(now - 20 * 60 * 1000).toISOString(),
    ref: { listingId: 'synced-gold', itemKind: 'gold' },
    meta: { priceUsd: 0.2 },
  },
  {
    account: 'main',
    type: 'market_list',
    ts: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    ref: { listingId: 'sold-gold', itemKind: 'gold' },
    meta: { priceUsd: 1.1 },
  },
  {
    account: 'main',
    type: 'market_sale',
    ts: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    amounts: { zolana: 110 },
    ref: { listingId: 'sold-gold' },
    meta: { priceUsd: 1.1 },
  },
], 0.01, { now });

ok(windowSummary.zolanaWindows?.h1?.revenueZolana === 120,
  `1h revenue ${windowSummary.zolanaWindows?.h1?.revenueZolana}`);
ok(windowSummary.zolanaWindows?.h1?.netZolana === 100,
  `1h net ${windowSummary.zolanaWindows?.h1?.netZolana}`);
ok(windowSummary.zolanaWindows?.h1?.netPerHour === 100,
  `1h net/h ${windowSummary.zolanaWindows?.h1?.netPerHour}`);
ok(windowSummary.zolanaWindows?.h6?.revenuePerHour === 48.33333333,
  `6h revenue/h ${windowSummary.zolanaWindows?.h6?.revenuePerHour}`);
ok(windowSummary.market?.pendingCount === 2 && windowSummary.market?.pendingUsd === 2.7,
  `pending market ${windowSummary.market?.pendingCount} $${windowSummary.market?.pendingUsd}`);
ok(windowSummary.market?.syncedCount === 1, `synced count ${windowSummary.market?.syncedCount}`);
ok(windowSummary.market?.soldCount === 4, `sold count ${windowSummary.market?.soldCount}`);

// ── estimateProfitUsd (2026-07-06): blended "Today's Net Profit"-style USD estimate ──
ok(estimateProfitUsd({ grossGold: 100000, netZolana: 500, goldFloorUsd: 0.000002, zolanaPriceUsd: 0.0003 }) === 0.35,
  `gold(100000×0.000002=0.2) + zolana(500×0.0003=0.15) = 0.35, got ${estimateProfitUsd({ grossGold: 100000, netZolana: 500, goldFloorUsd: 0.000002, zolanaPriceUsd: 0.0003 })}`);
ok(estimateProfitUsd({ grossGold: 100000, netZolana: 500, goldFloorUsd: null, zolanaPriceUsd: 0.0003 }) === 0.15,
  'missing gold rate → falls back to zolana-only, does not treat missing as zero-and-tank the total');
ok(estimateProfitUsd({ grossGold: 100000, netZolana: 500, goldFloorUsd: 0.000002, zolanaPriceUsd: null }) === 0.2,
  'missing zolana rate → falls back to gold-only');
ok(estimateProfitUsd({ grossGold: 100000, netZolana: 500 }) === null, 'no rates known at all → null, never a fabricated number');
ok(estimateProfitUsd() === null, 'no args at all → null, not a throw');
// net ZOLANA can be NEGATIVE (this session's fleet is currently net-losing tokens) — profit must
// reflect that as a real negative contribution, not clamp to zero.
ok(estimateProfitUsd({ grossGold: 0, netZolana: -1000, goldFloorUsd: null, zolanaPriceUsd: 0.0003 }) === -0.3,
  `negative net ZOLANA correctly produces a negative USD estimate, got ${estimateProfitUsd({ grossGold: 0, netZolana: -1000, goldFloorUsd: null, zolanaPriceUsd: 0.0003 })}`);

rmSync(logDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
