import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectState } from '../scripts/serve-dashboard.js';

// 2026-07-06 full dashboard rebuild (minimalist: KPI / floor candles / account cards / sales log).
// The old asserts on runtime statuses and the "Market" card were replaced with equivalents for the new sections.
test('web dashboard renders the four redesign sections with live data hooks', () => {
  const html = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');

  // KPI: NET from sales + the Jupiter rate (independent of the game) + pipeline
  assert.match(html, /Net from sales/);
  assert.match(html, /jupiterPriceUsd/);
  assert.match(html, /strategyFlows24h/);
  // floor candles: rarity tabs + history request with a window
  assert.match(html, /\/api\/market-history\?hours=/);
  assert.match(html, /CandlestickSeries/);
  assert.match(html, /no sales in window/);
  // cards: account value via floor×haircut
  assert.match(html, /VALUE_HAIRCUT\s*=\s*0\.70/);
  assert.match(html, /creatureFloorZolana/);
  // sales log: only sales.log (deduped on the server), NET on top
  assert.match(html, /sales\.log/);
  assert.match(html, /netZolana/);
});

test('web dashboard candles skip empty buckets and plot the median clearing price', () => {
  const html = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');

  // the chart plots the stable median clearing price, falling back to the min-floor for old snapshots
  assert.match(html, /clearingZolana\s*>\s*0\s*\?\s*r\.clearingZolana\s*:\s*r\.floorZolana/);
  assert.match(html, /pointPrice\(f\)\s*>\s*0/); // empty/zero points excluded — no flat/zero candles
  // USD conversion — via the nearest-in-time jupiter rate from prices
  assert.match(html, /nearestPrice/);
});

test('web dashboard state includes account summary for frontend rendering', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'zenko-web-dashboard-'));
  try {
    writeFileSync(join(logDir, 'live-main.json'), JSON.stringify({
      name: 'main',
      address: 'Main111111111111111111111111111111111111',
      ts: Date.now(),
      priceUsd: 0.5,
      player: { gold: 70000, gems: 4, level: 3, stamina: 120, zenko_balance: 1000 },
      counts: { creatures: 4, placed: 2, eggs: 1, pendingEggs: 1, runs: 1, mats: 3 },
      creaturesList: [
        { id: 'c1', species: 'Alpha', stage: 'Adult', level: 7, rarity: 'Rare' },
        { id: 'c2', species: 'Beta', stage: 'Elder', level: 3, rarity: 'Common' },
        { id: 'c3', species: 'Gamma', stage: 'Adult', level: 1, rarity: 'Common' },
        { id: 'c4', species: 'Delta', stage: 'Adult', level: 1, rarity: 'Common' },
      ],
      dungeonRuns: [{ id: 'run1', status: 'ready', party: ['c1'] }],
      zolanaHistory: [{ t: 0, zolana: 10 }, { t: 60 * 60 * 1000, zolana: 16 }],
      relics: { total: 3, equipped: 1 },
      materials: [{ type: 'ore' }, { type: 'ore' }, { type: 'wood' }],
      goldHistory: [{ t: 1, gold: 1000 }, { t: 2, gold: 70000 }],
      log: [],
    }), 'utf8');

    const state = collectState({ logDir, registryPath: join(logDir, 'missing-accounts.json') });
    const main = state.accounts[0];

    assert.equal(main.summary.hero.label, 'Beta Elder lvl 3');
    assert.equal(main.summary.dungeon.readyRuns, 1);
    assert.equal(main.summary.dungeon.fullParties, 1);
    assert.equal(main.summary.rates.zolanaPerHour, 6);
    assert.ok(main.summary.progress.percent > 0);
    assert.deepEqual(main.summary.loot.topMaterials[0], { name: 'ore', count: 2 });
    assert.ok(main.summary.recommendations.includes('Claim 1 ready dungeon run(s).'));
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('web dashboard includes registry accounts even before first live snapshot', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'zenko-web-dashboard-registry-'));
  try {
    const registryPath = join(logDir, 'accounts.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      accounts: [
        { name: 'Zephyr', address: 'Zephyr11111111111111111111111111111111', status: 'stamina_float_ready', proxyUrl: 'http://user:pass@proxy.local:8080' },
        { name: 'Ashen', address: 'Ashen111111111111111111111111111111111', status: 'awaiting_deposit' },
      ],
    }), 'utf8');
    writeFileSync(join(logDir, 'live-Zephyr.json'), JSON.stringify({
      name: 'Zephyr',
      address: 'Zephyr11111111111111111111111111111111',
      ts: Date.now(),
      player: { gold: 10, stamina: 180, zenko_balance: 2 },
      counts: { creatures: 1, eggs: 0, pendingEggs: 0, runs: 0, mats: 0 },
      creaturesList: [{ id: 'z1', species: 'Alpha', stage: 'Adult', level: 1 }],
    }), 'utf8');
    writeFileSync(join(logDir, 'live-test-only.json'), JSON.stringify({
      name: 'test-only',
      address: 'Test111111111111111111111111111111111',
    }), 'utf8');

    const state = collectState({ logDir, registryPath });
    assert.deepEqual(state.accounts.map(account => account.name), ['Ashen', 'Zephyr']);
    assert.equal(state.accounts.find(account => account.name === 'Ashen').hasLive, false);
    assert.equal(state.accounts.find(account => account.name === 'Ashen').registryStatus, 'awaiting_deposit');
    assert.equal(state.accounts.find(account => account.name === 'Zephyr').hasLive, true);
    assert.equal(state.accounts.find(account => account.name === 'Zephyr').proxy, 'http://proxy.local:8080');
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

// 24h flows for the "Strategy · breeding conveyor" section (2026-07-06): amounts summed BY event type
// — summarizeLedger doesn't provide that (it has counts and overall totals). Window, sign, and types.
import { summarizeStrategyFlows } from '../scripts/serve-dashboard.js';

test('summarizeStrategyFlows: sums by type within a 24h window, ignores out-of-window and foreign types', () => {
  const now = Date.parse('2026-07-06T12:00:00Z');
  const iso = (hAgo) => new Date(now - hAgo * 3600 * 1000).toISOString();
  const flows = summarizeStrategyFlows([
    { type: 'breed', ts: iso(1), amounts: { gold: -10000 } },
    { type: 'breed', ts: iso(2), amounts: { gold: -5000 } },
    { type: 'breed', ts: iso(30), amounts: { gold: -99999 } },        // older than 24h — skipped
    { type: 'market_sale', ts: iso(3), amounts: { zolana: 123.456 } },
    { type: 'dungeon_claim', ts: iso(1), amounts: { gold: 1438 } },   // not a strategic type — skipped
    { type: 'stamina_refill', ts: iso(4), amounts: { zolana: -150 } },
  ], { now });
  assert.equal(flows.breed.count, 2);
  assert.equal(flows.breed.gold, -15000);
  assert.equal(flows.market_sale.zolana, 123.456);
  assert.equal(flows.stamina_refill.zolana, -150);
  assert.equal(flows.egg_buy.count, 0, 'types with no events are present with zeros (the frontend does not check for the key)');
});

test('summarizeStrategyFlows: market_sale is deduped by listingId (raw ledger holds re-record duplicates)', () => {
  const now = Date.parse('2026-07-06T12:00:00Z');
  const iso = (hAgo) => new Date(now - hAgo * 3600 * 1000).toISOString();
  const flows = summarizeStrategyFlows([
    { type: 'market_sale', ts: iso(1), ref: { listingId: 'L1' }, amounts: { zolana: 100 } },
    { type: 'market_sale', ts: iso(1), ref: { listingId: 'L1' }, amounts: { zolana: 100 } }, // duplicate re-record of L1
    { type: 'market_sale', ts: iso(2), ref: { listingId: 'L2' }, amounts: { zolana: 50 } },
    { type: 'breed', ts: iso(1), ref: { listingId: 'L1' }, amounts: { gold: -1 } }, // non-sale: listingId irrelevant, not deduped
  ], { now });
  assert.equal(flows.market_sale.count, 2, 'two DISTINCT sales, not three raw events');
  assert.equal(flows.market_sale.zolana, 150, 'zolana not inflated by the duplicate');
  assert.equal(flows.breed.count, 1, 'non-sale types are never deduped');
});

// Sales for the dashboard redesign (2026-07-06): dedup by listingId is mandatory — the raw ledger contains
// historical duplicates (one sale recorded up to 19 times, see the sold-ids bug).
import { summarizeSales } from '../scripts/serve-dashboard.js';

test('summarizeSales: dedups by listingId, computes NET in Z and $, log newest-first', () => {
  const mk = (ts, listingId, z, usd, acct = 'A') => ({ type: 'market_sale', ts, account: acct, amounts: { zolana: z }, ref: { listingId, itemKind: 'creature' }, meta: { priceUsd: usd } });
  const s = summarizeSales([
    mk('2026-07-05T10:00:00Z', 'L1', 100, 0.05),
    mk('2026-07-05T10:00:01Z', 'L1', 100, 0.05), // duplicate of the same sale
    mk('2026-07-05T12:00:00Z', 'L2', 50, 0.03),
    { type: 'dungeon_claim', ts: '2026-07-05T11:00:00Z', amounts: { gold: 5 } }, // not a sale
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.netZolana, 150);
  assert.equal(s.netUsd, 0.08);
  assert.equal(s.log[0].ts, '2026-07-05T12:00:00Z', 'newest first');
});

test('summarizeSales carries account + rarity + traits (species/variant) into each log row', () => {
  const s = summarizeSales([
    { type: 'market_sale', ts: '2026-07-06T10:00:00Z', account: 'Nova',
      ref: { listingId: 'L9', itemKind: 'creature' },
      amounts: { zolana: 200 }, meta: { priceUsd: 0.05, rarity: 'uncommon', variant: 'rainbow', species: 'smoldra' } },
    { type: 'market_sale', ts: '2026-07-06T09:00:00Z', account: 'main',
      ref: { listingId: 'Lg', itemKind: 'gold' },
      amounts: { zolana: 50 }, meta: { priceUsd: 0.02 } }, // gold: no traits
  ]);
  const creature = s.log.find(r => r.itemKind === 'creature');
  assert.equal(creature.account, 'Nova');
  assert.equal(creature.rarity, 'uncommon');
  assert.equal(creature.species, 'smoldra');
  assert.equal(creature.variant, 'rainbow');
  const gold = s.log.find(r => r.itemKind === 'gold');
  assert.equal(gold.rarity, null, 'fungible gold has no rarity → dashboard renders —');
  assert.equal(gold.species, null);
});

test('summarizeSales backfills rarity/traits from our own market_list when the sale record lacks them', () => {
  const s = summarizeSales([
    // we listed the creature (we know its traits) …
    { type: 'market_list', ts: '2026-07-06T09:00:00Z', account: 'Kade',
      ref: { listingId: 'LX', itemKind: 'creature', itemId: 'cr1' },
      meta: { priceUsd: 0.04, rarity: 'rare', variant: 'normal', species: 'florix' } },
    // … then it sold, but the my-sales API gave us NO rarity on the sale record
    { type: 'market_sale', ts: '2026-07-06T11:00:00Z', account: 'Kade',
      ref: { listingId: 'LX', itemKind: 'creature' },
      amounts: { zolana: 150 }, meta: { priceUsd: 0.04 } },
  ]);
  const row = s.log[0];
  assert.equal(row.rarity, 'rare', 'rarity backfilled from our own listing by listingId');
  assert.equal(row.species, 'florix');
  assert.equal(row.variant, 'normal');
});
