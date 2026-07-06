import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

function makeBot(overrides = {}, clientOverrides = {}) {
  const client = {
    address: 'Test1111111111111111111111111111111111',
    wallet: {},
    api: async () => ({}),
    ...clientOverrides,
  };
  const bot = new ZenkoBot(client, {
    name: 'gaps',
    ledger: false,
    persistStaminaPending: false,
    epsilonProbe: false,
    ...overrides,
  });
  const starts = [];
  bot.act = async (path, body) => {
    if (path === '/api/dungeon/start') starts.push(body);
    return {};
  };
  return { bot, starts };
}

const roster = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, stage: 'Adult', level: 5, ...extra }));

test('reuses a just-claimed dungeon party in the same tick after state reload', async () => {
  const creatures = roster(3);
  const fresh = { creatures, dungeonRuns: [], player: { stamina: 10_000 } };
  let reloads = 0;
  const { bot, starts } = makeBot({ partySize: 3, dungeonId: 1 }, {
    api: async (path) => {
      if (path === '/api/player/load') {
        reloads++;
        return fresh;
      }
      return {};
    },
  });
  const claims = [];
  bot.act = async (path, body) => {
    if (path === '/api/dungeon/claim') claims.push(body);
    if (path === '/api/dungeon/start') starts.push(body);
    return {};
  };

  await bot.handleDungeons({
    creatures,
    dungeonRuns: [{
      id: 'run1',
      status: 'ready',
      ready_at: new Date(Date.now() - 1_000).toISOString(),
      party: ['c0', 'c1', 'c2'],
      dungeon_id: 1,
    }],
    player: { stamina: 10_000 },
  });

  assert.equal(claims.length, 1);
  assert.equal(reloads, 1, 'claiming should refresh busy/free creature state');
  assert.equal(starts.length, 1, 'claimed creatures should be dispatched again in the same tick');
  assert.deepEqual(starts[0].party, ['c0', 'c1', 'c2']);
});

test('does not start an incomplete dungeon party', async () => {
  const { bot, starts } = makeBot({ partySize: 3, dungeonId: 1 });

  await bot.handleDungeons({ creatures: roster(2), dungeonRuns: [], player: { stamina: 10_000 } });

  assert.equal(starts.length, 0, '2 idle creatures are not enough for a 3-creature dungeon party');
});

test('idle roster ranks unknown stages below known adult creatures', () => {
  const { bot } = makeBot();

  const sorted = bot.idleRoster({
    creatures: [
      { id: 'unknown', stage: 'Mystery', level: 99 },
      { id: 'adult', stage: 'Adult', level: 1 },
    ],
    dungeonRuns: [],
  });

  assert.equal(sorted[0].id, 'adult');
});

test('feeding respects minGoldReserve', async () => {
  const { bot } = makeBot({ minGoldReserve: 1_000 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };

  // Baby/Juvenile — handleFeeding now stage-gates to only these (2026-07 change); an Adult creature
  // here would be filtered out BEFORE the gold-reserve check even runs, making this test pass for the
  // wrong reason (trivially zero calls regardless of the gate under test).
  await bot.handleFeeding({
    player: { gold: 500 },
    creatures: [{ id: 'c0', stage: 'Juvenile', level: 1, last_feed_time: null }],
  });

  assert.equal(calls.length, 0, 'feed should not spend below configured gold reserve');
});

// 2026-07-06: per-tick feed cap is configurable — after the egg burst accounts hold 30+ Babies
// (Ember: 34), and the old hardcoded 3/tick starved the breed pipeline (Adults mature via feeds).
test('feeding: feedMaxPerTick caps feeds per tick (2 of 3 hungry Babies)', async () => {
  const { bot } = makeBot({ feedMaxPerTick: 2 });
  const fed = [];
  bot.act = async (path, body) => {
    if (path === '/api/creature/feed') fed.push(body.creatureId);
    return {};
  };

  await bot.handleFeeding({
    player: { gold: 999_999 },
    creatures: [
      { id: 'b1', species: 'a', stage: 'Baby', level: 1, last_feed_time: null },
      { id: 'b2', species: 'b', stage: 'Baby', level: 1, last_feed_time: null },
      { id: 'b3', species: 'c', stage: 'Baby', level: 1, last_feed_time: null },
    ],
  });

  assert.equal(fed.length, 2, `feeds exactly feedMaxPerTick creatures (got ${JSON.stringify(fed)})`);
});

// FEED LEDGER VISIBILITY 2026-07-05: handleFeeding never recorded a ledger event at all — feeding
// fires constantly (every ~10-15s per account once Baby/Juvenile exist) and spends real Gold, but was
// 100% invisible to our own accounting. Owner: "голда уходит куда-то" (gold disappears somewhere).
// Exact per-feed Gold cost isn't documented anywhere (NOTES.md only notes the 10-min cooldown) — we
// do NOT fabricate a number (costTracked:false), but the ACTIVITY itself must be visible now.
test('feeding records a creature_feed ledger event (visible, cost intentionally untracked)', async () => {
  const { bot } = makeBot();
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  bot.act = async () => ({});

  await bot.handleFeeding({
    player: { gold: 999_999 },
    creatures: [{ id: 'c0', species: 'nimbu', stage: 'Juvenile', level: 1, last_feed_time: null }],
  });

  assert.ok(ledger.some((e) => e.type === 'creature_feed' && e.ref?.creatureId === 'c0' && e.meta?.costTracked === false),
    `records a creature_feed event without fabricating a Gold amount (ledger: ${JSON.stringify(ledger)})`);
});

// REGRESSION 2026-07-06 (owner: "какая-то ошибка 409, кормятся ли питомцы?"): every OTHER handler in
// bot.js treats [400,402,409] as expected/benign (relic, breed, forge, vault, evolve...). handleFeeding
// was the one place that didn't — it only ignored 429/400, so a 409 (server-side cooldown not quite
// elapsed yet — the exact drift FEED_COOLDOWN_MS=11m already exists to work around) fell through to
// `break`, killing the WHOLE tick's feeding for every OTHER creature after it, not just the one that
// hit 409. Live data confirmed: main/spare fed ~1.1-1.4x/2h per eligible creature vs ~5-6x/2h fleet-wide.
test('feeding: a 409 on one creature does not block feeding the next eligible creature in the same tick', async () => {
  const { bot } = makeBot();
  const fed = [];
  bot.act = async (path, body) => {
    if (path === '/api/creature/feed') {
      if (body.creatureId === 'on-cooldown-serverside') { const e = new Error('conflict'); e.status = 409; throw e; }
      fed.push(body.creatureId);
      return {};
    }
    return {};
  };

  await bot.handleFeeding({
    player: { gold: 999_999 },
    creatures: [
      { id: 'on-cooldown-serverside', species: 'a', stage: 'Juvenile', level: 1, last_feed_time: null },
      { id: 'still-eligible-1', species: 'b', stage: 'Juvenile', level: 1, last_feed_time: null },
      { id: 'still-eligible-2', species: 'c', stage: 'Juvenile', level: 1, last_feed_time: null },
    ],
  });

  assert.deepEqual(fed, ['still-eligible-1', 'still-eligible-2'],
    `409 on the first creature is skipped, not fatal — the other two still get fed (got ${JSON.stringify(fed)})`);
});

test('feeding: 400/402/409/429 are all treated as expected-skip, matching the codebase-wide convention', async () => {
  for (const status of [400, 402, 409, 429]) {
    const { bot } = makeBot();
    const fed = [];
    bot.act = async (path, body) => {
      if (path !== '/api/creature/feed') return {};
      if (body.creatureId === 'blocked') { const e = new Error('x'); e.status = status; throw e; }
      fed.push(body.creatureId);
      return {};
    };
    await bot.handleFeeding({
      player: { gold: 999_999 },
      creatures: [
        { id: 'blocked', species: 'a', stage: 'Juvenile', level: 1, last_feed_time: null },
        { id: 'next', species: 'b', stage: 'Juvenile', level: 1, last_feed_time: null },
      ],
    });
    assert.deepEqual(fed, ['next'], `status ${status} is skipped, not fatal (got ${JSON.stringify(fed)})`);
  }
});

test('feeding: a genuinely unexpected error still stops the tick (not silently swallowed everywhere)', async () => {
  const { bot } = makeBot();
  const fed = [];
  bot.act = async (path, body) => {
    if (path !== '/api/creature/feed') return {};
    if (body.creatureId === 'weird-error') { const e = new Error('server exploded'); e.status = 500; throw e; }
    fed.push(body.creatureId);
    return {};
  };
  await bot.handleFeeding({
    player: { gold: 999_999 },
    creatures: [
      { id: 'weird-error', species: 'a', stage: 'Juvenile', level: 1, last_feed_time: null },
      { id: 'never-reached', species: 'b', stage: 'Juvenile', level: 1, last_feed_time: null },
    ],
  });
  assert.deepEqual(fed, [], 'an unrecognized status still halts the tick — this is a deliberate safety behavior, not the bug');
});

test('dungeon claim records dungeon id from reward payload when run metadata is missing', async () => {
  const { bot } = makeBot();
  const events = [];
  bot.recordEvent = (type, event) => { events.push({ type, event }); return event; };
  bot.act = async (path) => {
    if (path === '/api/dungeon/claim') {
      return { dungeonRewards: { gold: 123, dungeonId: 7 } };
    }
    return {};
  };
  bot.c.api = async (path) => {
    if (path === '/api/player/load') return { creatures: [], dungeonRuns: [], player: { stamina: 0 } };
    return {};
  };

  await bot.handleDungeons({
    creatures: [],
    dungeonRuns: [{
      id: 'run1',
      status: 'ready',
      ready_at: new Date(Date.now() - 1_000).toISOString(),
      party: [],
    }],
    player: { stamina: 0 },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'dungeon_claim');
  assert.equal(events[0].event.ref.dungeonId, 7);
});
