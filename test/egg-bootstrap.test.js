import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

// 2026-07-06 (owner: "for new accounts, buy 6 eggs at 50k, and later just breed on cooldown").
// A brand-new account buys a one-time batch of 50k elemental eggs to seed a breeding roster, then
// breeds only. Auto-gated to new accounts (small roster + few lifetime egg buys) so it never touches
// established accounts. Lifetime count comes from the ledger so it survives --watch restarts.
function makeBot(overrides = {}) {
  const calls = [];
  const bot = new ZenkoBot({
    address: 'Boot1111111111111111111111111111111111',
    wallet: {},
    api: async () => ({}),
  }, {
    name: 'boot',
    ledger: false,
    persistStaminaPending: false,
    minGoldReserve: 0,
    autoBuyEggs: false,
    bootstrapEggBuy: true,
    bootstrapEggCount: 6,
    bootstrapRosterMax: 12,
    bootstrapEggTypes: ['forest', 'ocean', 'mountain', 'volcano', 'sky'],
    eggQueueTarget: 6,
    ...overrides,
  });
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  bot.loadLedgerEvents = () => []; // fresh account: no prior egg buys
  return { bot, calls };
}
const buys = (calls) => calls.filter(c => c.path === '/api/egg/buy').map(c => c.body.eggType);
const ELEMENTALS = ['forest', 'ocean', 'mountain', 'volcano', 'sky'];

test('new account buys exactly bootstrapEggCount 50k elemental eggs', async () => {
  const { bot, calls } = makeBot();
  await bot.handleEggs({ player: { gold: 1_000_000 }, creatures: [{ id: 'starter' }], eggs: [] });
  const b = buys(calls);
  assert.equal(b.length, 6, 'buys exactly 6');
  assert.ok(b.every(t => ELEMENTALS.includes(t)), 'all 50k elemental types');
});

test('established account (roster ≥ bootstrapRosterMax) buys nothing', async () => {
  const { bot, calls } = makeBot();
  const creatures = Array.from({ length: 50 }, (_, i) => ({ id: 'c' + i }));
  await bot.handleEggs({ player: { gold: 1_000_000 }, creatures, eggs: [] });
  assert.equal(buys(calls).length, 0, 'no bootstrap for an established roster');
});

test('bootstrap does not re-buy after a --watch restart: lifetime egg_buy count caps it', async () => {
  const { bot, calls } = makeBot();
  bot.loadLedgerEvents = () => Array.from({ length: 6 }, () => ({ type: 'egg_buy' })); // already bought its 6
  await bot.handleEggs({ player: { gold: 1_000_000 }, creatures: [{ id: 's' }], eggs: [] });
  assert.equal(buys(calls).length, 0, 'batch already bought → buys nothing');
});

test('bootstrap resumes a partial batch: ledger shows 4 bought → buys 2 more', async () => {
  const { bot, calls } = makeBot();
  bot.loadLedgerEvents = () => Array.from({ length: 4 }, () => ({ type: 'egg_buy' }));
  await bot.handleEggs({ player: { gold: 1_000_000 }, creatures: [{ id: 's' }], eggs: [] });
  assert.equal(buys(calls).length, 2, 'tops up to bootstrapEggCount (6)');
});

test('bootstrap stops when Gold cannot afford another 50k egg (resumes later as Gold accrues)', async () => {
  const { bot, calls } = makeBot();
  // 120k gold → 2 × 50k eggs, then 20k left < 50k → stop
  await bot.handleEggs({ player: { gold: 120_000 }, creatures: [{ id: 's' }], eggs: [] });
  assert.equal(buys(calls).length, 2, 'buys only what Gold affords');
});

test('bootstrap is off by default (bootstrapEggBuy:false → established behavior, buys nothing)', async () => {
  const { bot, calls } = makeBot({ bootstrapEggBuy: false });
  await bot.handleEggs({ player: { gold: 1_000_000 }, creatures: [{ id: 's' }], eggs: [] });
  assert.equal(buys(calls).length, 0);
});

test('bootstrap eggs are ledgered with a bootstrap marker', async () => {
  const events = [];
  const { bot } = makeBot();
  bot.recordEvent = (type, ev) => { events.push({ type, ...ev }); return null; };
  await bot.handleEggs({ player: { gold: 1_000_000 }, creatures: [{ id: 's' }], eggs: [] });
  const eggBuys = events.filter(e => e.type === 'egg_buy');
  assert.equal(eggBuys.length, 6);
  assert.ok(eggBuys.every(e => e.meta?.bootstrap === true), 'each egg_buy tagged meta.bootstrap');
  assert.ok(eggBuys.every(e => e.amounts?.gold === -50000), 'each records the 50k Gold cost');
});
