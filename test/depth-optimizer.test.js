// Тесты оптимизатора глубины по Gold/стамину. Чистая функция + интеграция с ботом
// через подменённый источник ledger (без диска и сети).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestDepth, bestGoldPerStaminaDepth, goldPerStaminaByDepth } from '../src/depth-optimizer.js';
import { staminaCostForDungeon } from '../src/stamina.js';
import { ZenkoBot } from '../src/bot.js';

const claim = (dungeonId, gold) => ({ type: 'dungeon_claim', ref: { dungeonId }, amounts: { gold } });
const many = (dungeonId, gold, n) => Array.from({ length: n }, () => claim(dungeonId, gold));

test('gold/стамину считается на единицу стоимости стамины, а не абсолютный Gold', () => {
  // d5 стоит 6 стамины, d21 стоит 18. Абсолютно d21 даёт больше, но на стамину — меньше.
  const events = [...many(5, 600, 5), ...many(21, 1200, 5)];
  const byDepth = goldPerStaminaByDepth(events);
  assert.equal(byDepth.get(5).goldPerStamina, 600 / staminaCostForDungeon(5));   // 100
  assert.equal(byDepth.get(21).goldPerStamina, 1200 / staminaCostForDungeon(21)); // ~66.7
  assert.ok(byDepth.get(5).goldPerStamina > byDepth.get(21).goldPerStamina);
});

test('выбирает глубину с лучшим Gold/стамину, а не самую глубокую', () => {
  const events = [...many(5, 600, 5), ...many(21, 1200, 5)];
  assert.equal(bestGoldPerStaminaDepth(events, { ceiling: 25, minSamples: 3 }), 5);
});

test('objective gold-per-run выбирает самую жирную по Gold/забег (безлим-токены → макс кач)', () => {
  // те же данные: per-stamina победил бы d5, но per-run — d21 (больше Gold за забег).
  const events = [...many(5, 600, 5), ...many(21, 1200, 5)];
  assert.equal(bestDepth(events, { ceiling: 25, minSamples: 3, objective: 'gold-per-run' }), 21);
  assert.equal(bestDepth(events, { ceiling: 25, minSamples: 3, objective: 'gold-per-stamina' }), 5);
});

test('никогда не выбирает глубже потолка', () => {
  const events = [...many(3, 300, 5), ...many(10, 2000, 5)]; // d10 эффективнее, но потолок 5
  assert.equal(bestGoldPerStaminaDepth(events, { ceiling: 5, minSamples: 3 }), 3);
});

test('мало данных → null (вызывающий откатывается к жадному режиму)', () => {
  const events = [...many(7, 900, 2)]; // 2 < minSamples(3)
  assert.equal(bestGoldPerStaminaDepth(events, { ceiling: 25, minSamples: 3 }), null);
  assert.equal(bestGoldPerStaminaDepth([], { ceiling: 25, minSamples: 3 }), null);
});

test('игнорирует нулевой/неизвестный Gold и null-глубину (не искажает среднее)', () => {
  const events = [
    ...many(4, 400, 3),
    claim(4, 0),               // неизвестная награда — не считаем
    claim(null, 999),          // глубина неизвестна — не считаем
    { type: 'dungeon_start', ref: { dungeonId: 4 } }, // не claim
  ];
  const byDepth = goldPerStaminaByDepth(events);
  assert.equal(byDepth.get(4).samples, 3);
  assert.equal(byDepth.get(4).goldAvg, 400);
});

test('интеграция: бот с optimizeDepth целится в Gold/стамину-оптимум в пределах потолка', async () => {
  const client = { address: 'Opt11111111111111111111111111111111111', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, {
    name: 'opt', ledger: false, persistStaminaPending: false,
    optimizeDepth: true, depthMinSamples: 3, partySize: 3, epsilonProbe: false,
  });
  bot.depth = 12;          // жадно бот полез бы на 12
  bot.depthCeiling = 12;   // и это в пределах вывозимого
  // история говорит: d5 эффективнее d12 по Gold/стамину
  bot.loadLedgerEvents = () => [...many(5, 600, 5), ...many(12, 900, 5)];
  const starts = [];
  bot.act = async (path, body) => { if (path === '/api/dungeon/start') starts.push(body); return {}; };

  await bot.handleDungeons({
    creatures: Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, stage: 'Adult', level: 5 })),
    dungeonRuns: [], player: { stamina: 10_000 },
  });

  assert.equal(bot.efficientDepth, 5, 'оптимизатор выбрал d5');
  assert.ok(starts.length > 0 && starts.every(s => s.dungeonId === 5),
    `все партии ушли на d5, а не на жадные d12 (${starts.map(s => s.dungeonId).join(',')})`);
});

test('интеграция: без достаточных данных бот остаётся в жадном режиме (текущее поведение)', async () => {
  const client = { address: 'Opt22222222222222222222222222222222222', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, {
    name: 'opt2', ledger: false, persistStaminaPending: false,
    optimizeDepth: true, depthMinSamples: 3, partySize: 3, epsilonProbe: false,
  });
  bot.depth = 8;
  bot.depthCeiling = 8;
  bot.loadLedgerEvents = () => [claim(3, 300)]; // 1 наблюдение — мало
  const starts = [];
  bot.act = async (path, body) => { if (path === '/api/dungeon/start') starts.push(body); return {}; };

  await bot.handleDungeons({
    creatures: [{ id: 'c0', stage: 'Adult', level: 5 }],
    dungeonRuns: [], player: { stamina: 10_000 },
  });

  assert.equal(bot.efficientDepth, null, 'данных мало → null');
  assert.ok(starts.every(s => s.dungeonId === 8), 'жадно целится в потолок d8');
});
