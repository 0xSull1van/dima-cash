// Тесты адаптивного пробуждения: спим к ближайшему добежавшему забегу, в пределах [min,max].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

function makeBot(overrides = {}) {
  const client = { address: 'Tick1111111111111111111111111111111111', wallet: {}, api: async () => ({}) };
  return new ZenkoBot(client, { name: 'tick', ledger: false, persistStaminaPending: false,
    tickMinSec: 45, tickMaxSec: 120, urgentTickMinSec: 8, urgentTickMaxSec: 20, ...overrides });
}
const runReadyInMs = (ms) => ({ status: 'active', ready_at: new Date(Date.now() + ms).toISOString(), party: [] });

test('просыпается к ближайшему забегу, когда тот в пределах [min,max]', () => {
  const bot = makeBot();
  // ближайший добежит через 70с (в окне 45..120) → ждём ~70с (±10% джиттер)
  const state = { dungeonRuns: [runReadyInMs(70_000), runReadyInMs(300_000)] };
  const wait = bot.nextWaitMs(state);
  assert.ok(wait >= 45_000 && wait <= 120_000, `в границах (got ${wait})`);
  assert.ok(Math.abs(wait - 70_000) <= 8_000, `около 70с ±джиттер (got ${wait})`);
});

test('забег уже добежал → urgent interval, не ждём обычный tickMinSec', () => {
  const bot = makeBot({ rng: () => 0.5 });
  const state = { dungeonRuns: [runReadyInMs(-5_000), runReadyInMs(300_000)] };
  const wait = bot.nextWaitMs(state);
  assert.ok(wait >= 8_000 && wait <= 20_000, `urgent window (got ${wait})`);
  assert.ok(wait < 45_000, `короче обычного min tick (got ${wait})`);
});

test('забег вот-вот добежит → просыпаемся вскоре после ready, не через tickMinSec', () => {
  const bot = makeBot({ rng: () => 0.5 });
  const state = { dungeonRuns: [runReadyInMs(2_000), runReadyInMs(300_000)] };
  const wait = bot.nextWaitMs(state);
  assert.ok(wait >= 10_000 && wait <= 22_000, `ready soon + urgent window (got ${wait})`);
  assert.ok(wait < 45_000, `короче обычного min tick (got ${wait})`);
});

test('дальний забег → не залипаем дольше tickMaxSec', () => {
  const bot = makeBot();
  const state = { dungeonRuns: [runReadyInMs(30 * 60_000)] };
  const wait = bot.nextWaitMs(state);
  assert.ok(wait <= 120_000, `не спим дольше max (got ${wait})`);
});

test('нет активных забегов → обычный интервал в [min,max]', () => {
  const bot = makeBot();
  for (let i = 0; i < 20; i++) {
    const wait = bot.nextWaitMs({ dungeonRuns: [] });
    assert.ok(wait >= 45_000 && wait <= 120_000, `в границах (got ${wait})`);
  }
});

test('claimed/done забеги игнорируются как сигнал пробуждения', () => {
  const bot = makeBot();
  const state = { dungeonRuns: [
    { status: 'claimed', ready_at: new Date(Date.now() + 50_000).toISOString() },
    { status: 'done', ready_at: new Date(Date.now() + 55_000).toISOString() },
  ] };
  // все неактивны → трактуем как «нет забегов», интервал просто в границах
  const wait = bot.nextWaitMs(state);
  assert.ok(wait >= 45_000 && wait <= 120_000, `в границах (got ${wait})`);
});

test('adaptiveTick:false → всегда случайный интервал в границах', () => {
  const bot = makeBot({ adaptiveTick: false });
  const state = { dungeonRuns: [runReadyInMs(70_000)] };
  for (let i = 0; i < 20; i++) {
    const wait = bot.nextWaitMs(state);
    assert.ok(wait >= 45_000 && wait <= 120_000, `в границах (got ${wait})`);
  }
});
