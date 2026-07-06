import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZenkoBot } from '../src/bot.js';

// soldMarketIds (the dedupe set for market_sale ledger events) lived ONLY in memory — every process
// restart (frequent under `--watch`) reset it, so the next handleCashout re-read the server's whole
// sales history and re-recorded every past sale as "new". Found live 2026-07-06: raw ledger showed 75
// market_sale events, real distinct sales (dedup by listingId) = 5 — a 15x inflation, actively
// WORSENING with every restart. soldMarketIdsPath() uses the hardcoded module-level LOG_DIR (src/bot.js,
// not dependency-injected — same constraint as writeLive, see test/write-live-stored.test.js), so this
// test uses a throwaway account name against the REAL logs dir and cleans up after itself.
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const NAME = '__test_sold_market_ids__';
const FILE = join(LOG_DIR, `sold-ids-${NAME}.json`);

function mockClient() {
  return {
    address: 'Test2222222222222222222222222222222222222',
    wallet: {},
    api: async (path) => {
      if (path === '/api/market/browse?kind=gold') return { listings: [] };
      if (path.startsWith('/api/market/my-sales')) {
        return { sales: [{ id: 'sale-abc', item_kind: 'creature', item_id: 'c1', price_usd: 0.05, currency: 'zenko', buyer: 'Buyer111' }] };
      }
      return {};
    },
  };
}

test('soldMarketIds persists to disk and survives a fresh ZenkoBot instance (simulated restart)', async () => {
  try {
    // "Restart" #1: fresh bot, no persisted file yet — the sale is genuinely new.
    const client1 = mockClient();
    const bot1 = new ZenkoBot(client1, { name: NAME, ledger: false, autoSellGold: true, autoSellJunk: false });
    assert.equal(bot1.soldMarketIds.size, 0, 'starts empty — no persisted file exists yet');

    const ledger1 = [];
    bot1.recordEvent = (type, event) => ledger1.push({ type, ...event });
    await bot1.handleCashout({ player: { gold: 0, zenko_balance: 0 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] });

    assert.ok(ledger1.some(e => e.type === 'market_sale' && e.ref?.listingId === 'sale-abc'),
      `first run records the sale as new (ledger: ${JSON.stringify(ledger1)})`);
    assert.ok(existsSync(FILE), 'saveSoldMarketIds wrote the persisted file');
    assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), ['sale-abc'], 'persisted file contains exactly the seen sale id');

    // "Restart" #2: a NEW ZenkoBot instance (simulating the process restarting under --watch),
    // same account name, same still-live sale from the server. This is the exact bug scenario —
    // the fix means it must NOT be re-recorded as new.
    const client2 = mockClient();
    const bot2 = new ZenkoBot(client2, { name: NAME, ledger: false, autoSellGold: true, autoSellJunk: false });
    assert.equal(bot2.soldMarketIds.size, 1, 'fresh instance restores the previously-seen sale id from disk');
    assert.ok(bot2.soldMarketIds.has('sale-abc'));

    const ledger2 = [];
    bot2.recordEvent = (type, event) => ledger2.push({ type, ...event });
    await bot2.handleCashout({ player: { gold: 0, zenko_balance: 0 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] });

    assert.equal(ledger2.filter(e => e.type === 'market_sale').length, 0,
      `post-restart, the same still-live sale is NOT re-recorded as new (ledger: ${JSON.stringify(ledger2)})`);
  } finally {
    if (existsSync(FILE)) unlinkSync(FILE);
  }
});

test('persistSoldMarketIds:false disables disk I/O entirely (opt-out for tests/experiments)', async () => {
  const path = join(LOG_DIR, `sold-ids-${NAME}__optout.json`);
  try {
    const client = mockClient();
    const bot = new ZenkoBot(client, { name: `${NAME}__optout`, ledger: false, autoSellGold: true, autoSellJunk: false, persistSoldMarketIds: false });
    bot.recordEvent = () => {};
    await bot.handleCashout({ player: { gold: 0, zenko_balance: 0 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] });
    assert.equal(existsSync(path), false, 'no file written when persistSoldMarketIds is explicitly disabled');
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test('a corrupt persisted file is treated as empty, not a crash', () => {
  const badName = `${NAME}__corrupt`;
  const path = join(LOG_DIR, `sold-ids-${badName}.json`);
  try {
    require('node:fs').writeFileSync(path, 'not valid json{{{');
  } catch { /* fall through to fs import below if require isn't available in this module context */ }
  try {
    const bot = new ZenkoBot({ address: 'Test3333333333333333333333333333333333333' }, { name: badName, ledger: false });
    assert.equal(bot.soldMarketIds.size, 0, 'corrupt file → starts empty, does not throw');
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});
