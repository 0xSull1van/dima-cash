// Тесты диспатча параллельных забегов. Изолированы от сети/кошелька: клиент — заглушка,
// this.act застаблен (без реальных HTTP и без человеческих пауз), ledger выключен.
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
    name: 'test',
    ledger: false,
    persistStaminaPending: false,
    epsilonProbe: false, // изолируем диспатч от ε-пробы (у неё свой тест-файл)
    ...overrides,
  });
  const starts = [];
  // подменяем act: считаем dungeon/start, всё остальное — no-op, без sleep/HTTP
  bot.act = async (path, body) => {
    if (path === '/api/dungeon/start') starts.push(body);
    return {};
  };
  return { bot, starts };
}

const roster = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, stage: 'Adult', level: 5, ...extra }));

test('стартует ВСЕ партии за один тик, покрывая весь простаивающий ростер', async () => {
  const { bot, starts } = makeBot({ partySize: 3, dungeonId: 1 });
  const creatures = roster(9);
  await bot.handleDungeons({ creatures, dungeonRuns: [], player: { stamina: 10_000 } });

  assert.equal(starts.length, 3, 'должно стартовать 9/3 = 3 партии');
  const ids = starts.flatMap(s => s.party);
  assert.equal(ids.length, 9, 'все 9 существ в бою');
  assert.equal(new Set(ids).size, 9, 'ни одно существо не задублировано между партиями');
});

test('денежный инвариант: не более одного рефилла стамины за тик', async () => {
  const { bot, starts } = makeBot({ partySize: 3, dungeonId: 1, autoBuyStamina: true });
  let refillCalls = 0;
  bot.handleStaminaRefill = async () => { refillCalls++; return false; }; // рефилл отклонён → стоп
  const creatures = roster(30); // хватило бы на 10 партий, но стамины нет
  await bot.handleDungeons({ creatures, dungeonRuns: [], player: { stamina: 0 } });

  assert.equal(refillCalls, 1, 'рефилл вызван ровно один раз, а не по разу на партию');
  assert.equal(starts.length, 0, 'без стамины ни один забег не стартует');
});

test('после успешного рефилла диспатчит остаток ростера (один рефилл)', async () => {
  const creatures = roster(30);
  const { bot, starts } = makeBot({ partySize: 3, dungeonId: 1, autoBuyStamina: true });
  let refillCalls = 0;
  bot.handleStaminaRefill = async () => { refillCalls++; return true; };
  // после рефилла бот перечитывает стейт — отдаём полный бак и тот же ростер
  bot.c.api = async (path) =>
    path === '/api/player/load' ? { creatures, dungeonRuns: [], player: { stamina: 10_000 } } : {};

  await bot.handleDungeons({ creatures, dungeonRuns: [], player: { stamina: 0 } });

  assert.equal(refillCalls, 1, 'ровно один платный рефилл');
  assert.equal(starts.length, 10, 'после рефилла ушли все 30/3 = 10 партий');
});

test('маховик глубины двигается один раз за тик, все партии на одной проверенной глубине', async () => {
  const { bot, starts } = makeBot({ partySize: 3, dungeonId: 5 });
  bot.depth = 5;
  bot.depthCeiling = 5; // проверенная глубина 5, без пробы глубже
  const creatures = roster(12);
  await bot.handleDungeons({ creatures, dungeonRuns: [], player: { stamina: 10_000 } });

  assert.equal(starts.length, 4, '12/3 = 4 партии');
  assert.ok(starts.every(s => s.dungeonId === 5), 'все партии на глубине 5 в пределах тика');
  assert.equal(bot.depth, 6, 'маховик поднял цель до 6 ровно один раз');
});
