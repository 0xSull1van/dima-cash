// Тесты ε-разведки глубины: периодическая проба потолок+1, чтобы сложность данжей
// росла вслед за силой ростера (иначе optimizeDepth морозит потолок навсегда).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

function makeBot(overrides = {}) {
  const client = { address: 'Probe111111111111111111111111111111111', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'probe', ledger: false, persistStaminaPending: false,
    partySize: 3, epsilonProbe: true, ...overrides });
  const starts = [];
  // powerWallAt: на этой глубине и выше сервер отклоняет по силе
  bot.act = async (path, body) => {
    if (path === '/api/dungeon/start') {
      if (overrides.powerWallAt != null && body.dungeonId >= overrides.powerWallAt) {
        const e = new Error('weak'); e.status = 400; e.bodyText = 'Party power too low'; throw e;
      }
      starts.push(body);
    }
    return {};
  };
  return { bot, starts };
}
const roster = (n) => Array.from({ length: n }, (_, i) => ({ id: 'c' + i, stage: 'Adult', level: 5 }));
const state = (n, stamina = 10_000) => ({ creatures: roster(n), dungeonRuns: [], player: { stamina } });

test('на probe-тик пробует ОДНУ партию на потолок+1 и поднимает потолок при успехе', async () => {
  const { bot, starts } = makeBot();
  bot.depthCeiling = 5; bot.depth = 5; bot.nextForcedProbeAt = 0;
  await bot.maybeProbeDeeper(state(6));
  assert.equal(starts.length, 1, 'ровно одна проба-партия');
  assert.equal(starts[0].dungeonId, 6, 'на потолок+1');
  assert.equal(starts[0].probe ?? starts[0].party.length, 3); // партия из 3
  assert.equal(bot.depthCeiling, 6, 'потолок поднят');
});

test('провал по силе: потолок не растёт, но проба троттлится (нет шторма ретраев)', async () => {
  const { bot, starts } = makeBot({ powerWallAt: 6 });
  bot.depthCeiling = 5; bot.depth = 5; bot.nextForcedProbeAt = 0;
  await bot.maybeProbeDeeper(state(6));
  assert.equal(starts.length, 0, 'ни одного успешного старта');
  assert.equal(bot.depthCeiling, 5, 'потолок остался');
  assert.ok(bot.nextForcedProbeAt > Date.now(), 'следующая проба отложена');
});

test('троттл: в пределах depthProbeMs повторно не пробует', async () => {
  const { bot, starts } = makeBot();
  bot.depthCeiling = 5; bot.nextForcedProbeAt = Date.now() + 60_000; // ещё рано
  await bot.maybeProbeDeeper(state(6));
  assert.equal(starts.length, 0, 'проба не сработала до срока');
});

test('не пробует, если бесплатной стамины не хватает (не триггерит платный долив)', async () => {
  const { bot, starts } = makeBot();
  bot.depthCeiling = 5; bot.nextForcedProbeAt = 0;
  await bot.maybeProbeDeeper(state(6, 3)); // 3 стамины < стоимости d6
  assert.equal(starts.length, 0, 'без стамины пробы нет');
  assert.equal(bot.nextForcedProbeAt, 0, 'таймер пробы не сдвинут — попробуем позже');
});

test('не пробует на максимальном потолке 25', async () => {
  const { bot, starts } = makeBot();
  bot.depthCeiling = 25; bot.nextForcedProbeAt = 0;
  await bot.maybeProbeDeeper(state(6));
  assert.equal(starts.length, 0, 'выше 25 некуда');
});

test('epsilonProbe:false полностью отключает пробу', async () => {
  const { bot, starts } = makeBot({ epsilonProbe: false });
  bot.depthCeiling = 5; bot.nextForcedProbeAt = 0;
  await bot.maybeProbeDeeper(state(6));
  assert.equal(starts.length, 0, 'проба выключена');
});

test('интеграция: после успешной пробы остаток ростера уходит на новую глубину', async () => {
  // 6 существ: 3 уйдут в пробу на d6, после reload остаётся 3 → они диспатчатся на d6.
  const client = { address: 'Probe222222222222222222222222222222222', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'probe2', ledger: false, persistStaminaPending: false,
    partySize: 3, epsilonProbe: true });
  bot.depthCeiling = 5; bot.depth = 5; bot.nextForcedProbeAt = 0;
  const starts = [];
  bot.act = async (path, body) => { if (path === '/api/dungeon/start') starts.push(body); return {}; };
  // после пробы reload отдаёт оставшихся 3 существ (проба-партия «занята»)
  bot.c.api = async (path) => path === '/api/player/load'
    ? { creatures: roster(6).slice(3), dungeonRuns: [], player: { stamina: 10_000 } } : {};

  await bot.handleDungeons(state(6));
  assert.equal(bot.depthCeiling, 6, 'потолок поднят пробой');
  assert.equal(starts.length, 2, '1 проба + 1 партия остатка');
  assert.ok(starts.every(s => s.dungeonId === 6), `всё на новой глубине d6 (${starts.map(s => s.dungeonId).join(',')})`);
});
