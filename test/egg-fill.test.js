import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

function makeBot(overrides = {}) {
  const calls = [];
  const bot = new ZenkoBot({
    address: 'Egg111111111111111111111111111111111111',
    wallet: {},
    api: async () => ({}),
  }, {
    name: 'eggs',
    ledger: false,
    persistStaminaPending: false,
    autoBuyEggs: true,
    elementalEggAfter: 0,
    minGoldReserve: 0,
    ...overrides,
  });
  bot.act = async (path, body) => {
    calls.push({ path, body });
    return {};
  };
  return { bot, calls };
}

function httpError(status, bodyText) {
  const error = new Error(bodyText);
  error.status = status;
  error.bodyText = bodyText;
  return error;
}

test('handleEggs fills empty egg queue with 50k elemental eggs in one pass', async () => {
  const { bot, calls } = makeBot();

  await bot.handleEggs({
    player: { gold: 200_000 },
    creatures: [],
    eggs: [],
  });

  assert.deepEqual(calls.filter(call => call.path === '/api/egg/buy').map(call => call.body.eggType), [
    'forest',
    'ocean',
    'mountain',
    'volcano',
  ]);
});

test('handleEggs only buys missing slots and stops when gold cannot afford another 50k egg', async () => {
  const { bot, calls } = makeBot();

  await bot.handleEggs({
    player: { gold: 100_000 },
    creatures: [],
    eggs: [
      { id: 'e1', status: 'inventory', egg_type: 'forest' },
      { id: 'old', status: 'hatched', egg_type: 'basic' },
    ],
  });

  assert.deepEqual(calls.filter(call => call.path === '/api/egg/buy').map(call => call.body.eggType), [
    'forest',
    'ocean',
  ]);
});

// 2026-07-06 (друг): lux-яйца как брид-сток анкамонов — ротация типов теперь конфигурируема.
test('handleEggs buys the configured elementalEggTypes (lux) and deducts its 60k price', async () => {
  const { bot, calls } = makeBot({ elementalEggTypes: ['lux'] });

  await bot.handleEggs({
    player: { gold: 100_000 },
    creatures: [],
    eggs: [],
  });

  // 100k gold: первый lux списывает 60k → остаток 40k < 60k → стоп. Если бы цена была 50k
  // (как у элементных), купились бы ДВА — тест ловит и тип, и именно 60k-цену.
  assert.deepEqual(calls.filter(call => call.path === '/api/egg/buy').map(call => call.body.eggType), ['lux']);
});

test('handleEggs stops buying at eggBuyDailyCap even with gold and empty queue', async () => {
  const { bot, calls } = makeBot({ elementalEggTypes: ['lux'], eggBuyDailyCap: 2, eggQueueTarget: 6 });

  await bot.handleEggs({
    player: { gold: 1_000_000 },
    creatures: [],
    eggs: [],
  });

  assert.equal(calls.filter(call => call.path === '/api/egg/buy').length, 2, 'cap 2 < queue deficit 6');
});

// --watch рестартит процесс на каждое сохранение — in-memory счётчик дня обнулялся бы и кап
// пробивался. Свежесозданный за сегодня счётчик сидится из ledger (egg_buy с сегодняшней UTC-датой).
test('eggBuyDailyCap counter is seeded from today ledger egg_buy events (survives restarts)', async () => {
  const { bot, calls } = makeBot({ elementalEggTypes: ['lux'], eggBuyDailyCap: 3, eggQueueTarget: 6 });
  const today = new Date().toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  bot.loadLedgerEvents = () => [
    { type: 'egg_buy', ts: today },
    { type: 'egg_buy', ts: today },
    { type: 'egg_buy', ts: yesterday },      // вчерашняя покупка НЕ в счёт
    { type: 'dungeon_start', ts: today },    // чужой тип события НЕ в счёт
  ];

  await bot.handleEggs({
    player: { gold: 1_000_000 },
    creatures: [],
    eggs: [],
  });

  assert.equal(calls.filter(call => call.path === '/api/egg/buy').length, 1,
    'cap 3 минус 2 уже купленных сегодня (из ledger) = 1 оставшаяся покупка');
});

test('handleEggs backs off after egg buy reports insufficient server-side gold', async () => {
  const { bot, calls } = makeBot({ eggBuyRetryMs: 60_000 });
  bot.act = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/egg/buy') {
      throw httpError(402, '{"error":"Not enough Gold"}');
    }
    return {};
  };

  const state = {
    player: { gold: 200_000 },
    creatures: [],
    eggs: [],
  };

  await bot.handleEggs(state);
  await bot.handleEggs(state);

  assert.equal(calls.filter(call => call.path === '/api/egg/buy').length, 1);
});

test('handleEggs backs off after hatch reports squad full', async () => {
  const { bot, calls } = makeBot();
  bot.act = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/egg/hatch') {
      throw httpError(409, '{"error":"Squad full — sacrifice or vault a creature to make room first"}');
    }
    return {};
  };

  const state = {
    player: { gold: 0 },
    creatures: [],
    eggs: [
      { id: 'ready-1', status: 'ready', egg_type: 'forest' },
      { id: 'ready-2', status: 'ready', egg_type: 'ocean' },
      { id: 'ready-3', status: 'ready', egg_type: 'sky' },
    ],
  };

  await bot.handleEggs(state);
  await bot.handleEggs(state);

  // two immediate passes → only one hatch attempt (short squad-full backoff still gates the 2nd)
  assert.equal(calls.filter(call => call.path === '/api/egg/hatch').length, 1);
});

test('squad-full uses SHORT backoff (not the 10-min eggHatchRetryMs) so hatch retries after slots free', async () => {
  const { bot } = makeBot({ eggHatchRetryMs: 10 * 60 * 1000, eggHatchSquadFullRetryMs: 45_000 });
  bot.act = async (path) => {
    if (path === '/api/egg/hatch') throw httpError(409, '{"error":"Squad full — sacrifice or vault a creature to make room first"}');
    return {};
  };
  const now = 1_000_000;
  const res = await bot.hatchReadyEggs({ eggs: [{ id: 'r', status: 'ready' }] }, now);
  assert.equal(res.squadFull, true, 'reports squadFull');
  // backoff is the short one, NOT the 10-min eggHatchRetryMs
  assert.equal(bot.nextEggHatchAt, now + 45_000, `short backoff (got ${bot.nextEggHatchAt - now}ms)`);
});

test('hatchReadyEggs hatches all ready eggs and reports count', async () => {
  const { bot, calls } = makeBot();
  bot.act = async (path, body) => { calls.push({ path, body }); return { creature: { species: 'nimbu', rarity: 'Common' } }; };
  const res = await bot.hatchReadyEggs({
    eggs: [
      { id: 'a', status: 'ready' },
      { id: 'b', status: 'incubating', hatch_ready_at: '2020-01-01T00:00:00Z' }, // past → ready
      { id: 'c', status: 'incubating', hatch_ready_at: '2999-01-01T00:00:00Z' }, // future → not ready
      { id: 'd', status: 'inventory' },                                          // not incubating
    ],
  });
  assert.equal(res.hatched, 2, 'hatches the 2 ready eggs (ready + past-timer), skips future/inventory');
  assert.equal(calls.filter(c => c.path === '/api/egg/hatch').length, 2);
});
