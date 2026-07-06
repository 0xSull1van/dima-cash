// Тесты оценки реликов по статам и планировщика экипировки «лучшее — сильнейшим».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRelic, planRelicEquip, planTrainerRelicEquip } from '../src/relic-optimizer.js';
import { ZenkoBot } from '../src/bot.js';

const relic = (id, slot, rarity, affixes, extra = {}) =>
  ({ id, class: 'combat', slot, rarity, affixes, equipped_on: null, equip_slot: null,
     listed: false, stored: false, aura_tier: 0, enhance_level: 0, ...extra });
const cr = (id, stage, level) => ({ id, stage, level });

// фикстуры на форме реального стейта
const r_hp_common = relic('r1', 'hp_pct', 'Common', [{ key: 'hp_pct', value: 0.01 }]);
const r_crit_unc  = relic('r2', 'crit_dmg', 'Uncommon', [{ key: 'crit_dmg', value: 0.04 }], { aura_tier: 1 });
const r_hp_rare   = relic('r3', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.11 }, { key: 'lifesteal', value: 0.045 }], { aura_tier: 2 });

test('scoreRelic суммирует аффиксы; редкость — лишь тай-брейк, не перебивает статы', () => {
  assert.ok(scoreRelic(r_hp_rare) > scoreRelic(r_crit_unc));
  assert.ok(scoreRelic(r_crit_unc) > scoreRelic(r_hp_common));
  // равные статы, разная редкость → выигрывает более редкий, но разрыв крошечный
  const a = relic('a', 'x', 'Common', [{ key: 'x', value: 0.05 }]);
  const b = relic('b', 'x', 'Rare', [{ key: 'x', value: 0.05 }]);
  assert.ok(scoreRelic(b) > scoreRelic(a));
  assert.ok(scoreRelic(b) - scoreRelic(a) < 0.01, 'тай-брейк не перебивает разницу в статах');
});

test('веса статов управляют приоритетом', () => {
  const off = relic('o', 'crit', 'Common', [{ key: 'crit_dmg', value: 0.05 }]);
  const def = relic('d', 'hp', 'Common', [{ key: 'hp_pct', value: 0.05 }]);
  assert.ok(scoreRelic(off, { weights: { crit_dmg: 3 } }) > scoreRelic(def, { weights: { crit_dmg: 3 } }));
});

test('лучший релик каждого слота — сильнейшему существу; второй по слоту — следующему', () => {
  const relics = [r_hp_common, r_crit_unc, r_hp_rare];
  const creatures = [cr('c1', 'Adult', 6), cr('c2', 'Juvenile', 5)];
  const { equip, unequip } = planRelicEquip(relics, creatures);
  assert.equal(unequip.length, 0);
  // c1 (сильнейший) забирает лучший hp (r3) и единственный crit (r2); c2 — оставшийся hp (r1)
  assert.deepEqual(equip, [
    { relicId: 'r3', target: 'c1', slot: 'hp_pct' },
    { relicId: 'r2', target: 'c1', slot: 'crit_dmg' },
    { relicId: 'r1', target: 'c2', slot: 'hp_pct' },
  ]);
});

test('релик не назначается дважды и не более одного на слот существа', () => {
  const relics = [r_hp_common, r_hp_rare]; // оба hp_pct
  const creatures = [cr('c1', 'Adult', 6)];
  const { equip } = planRelicEquip(relics, creatures);
  assert.equal(equip.length, 1, 'один hp-слот у существа → только один релик');
  assert.equal(equip[0].relicId, 'r3', 'и это лучший по статам');
});

// equip_slot реалистично НЕ совпадает с relic.slot (реальная форма сервера: slot="hp_pct" — тип
// стата, equip_slot="combat_a" — физический слот сервера, подтверждено live-дампом 2026-07-06).
test('идемпотентность: уже правильно надетый релик не переэкипируется (equip_slot ≠ relic.slot, как в реальных данных)', () => {
  const onC1 = relic('r3', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.11 }], { equipped_on: 'c1', equip_slot: 'combat_a' });
  const { equip, unequip } = planRelicEquip([onC1], [cr('c1', 'Adult', 6)]);
  assert.equal(equip.length, 0, 'уже на месте — нет действий, даже когда equip_slot не похож на relic.slot');
  assert.equal(unequip.length, 0);
});

// РЕГРЕССИЯ 2026-07-06: старая проверка `relic.equipped_on === cr.id && relic.equip_slot === slot`
// сравнивала физический слот сервера с типом стата — эти поля из разных словарей и никогда не
// совпадают, поэтому planRelicEquip никогда не признавал релик «уже на месте» и переэкипировал его
// КАЖДЫЙ вызов handleRelics (~200 relic_equip/акк за 20 мин живьём, до полного вытеснения данжей
// на main/Fury). Этот тест ловит именно тот баг, который проскочил через предыдущую версию теста
// выше (там equip_slot искусственно приравнивался к relic.slot, маскируя проблему).
test('РЕГРЕССИЯ: без фикса relic.equip_slot никогда не совпадёт с relic.slot → бесконечный re-equip', () => {
  const stillOnC1 = relic('r3', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.11 }], { equipped_on: 'c1', equip_slot: 'combat_a' });
  const second = planRelicEquip([stillOnC1], [cr('c1', 'Adult', 6)]);
  assert.equal(second.equip.length, 0, 'повторный вызов планировщика с тем же состоянием не переэкипирует');
});

test('переезд: неверно надетый релик снимается, затем надевается на нужного', () => {
  const onWrong = relic('r3', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.11 }], { equipped_on: 'c2', equip_slot: 'combat_a' });
  const creatures = [cr('c1', 'Adult', 6), cr('c2', 'Juvenile', 5)];
  const { equip, unequip } = planRelicEquip([onWrong], creatures);
  assert.deepEqual(unequip, [{ relicId: 'r3' }], 'снять с c2');
  assert.deepEqual(equip, [{ relicId: 'r3', target: 'c1', slot: 'hp_pct' }], 'надеть на c1 (сильнейший)');
});

test('пропускает не-combat / listed / stored релики', () => {
  const cosmeticClass = relic('x1', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.2 }], { class: 'cosmetic' });
  const listed = relic('x2', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.2 }], { listed: true });
  const stored = relic('x3', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.2 }], { stored: true });
  const { equip } = planRelicEquip([cosmeticClass, listed, stored, r_hp_common], [cr('c1', 'Adult', 6)]);
  assert.deepEqual(equip, [{ relicId: 'r1', target: 'c1', slot: 'hp_pct' }], 'только валидный combat-релик');
});

test('интеграция: handleRelics шлёт unequip перед equip, best-effort при отказе сервера', async () => {
  const client = { address: 'Relic11111111111111111111111111111111', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'relic', ledger: false, persistStaminaPending: false,
    autoEquipRelics: true });
  const calls = [];
  bot.act = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/relic/equip' && body.relicId === 'r2') { const e = new Error('bad'); e.status = 400; e.bodyText = 'invalid slot'; throw e; }
    return {};
  };
  const relics = [r_hp_common, r_crit_unc, r_hp_rare];
  const creatures = [cr('c1', 'Adult', 6), cr('c2', 'Juvenile', 5)];
  await bot.handleRelics({ relics, creatures });

  const equips = calls.filter(c => c.path === '/api/relic/equip').map(c => c.body.relicId);
  assert.deepEqual(equips, ['r3', 'r2', 'r1'], 'пытается надеть все, включая отклонённый r2');
  // отказ r2 (400) не прерывает — r1 всё равно надет
  assert.ok(equips.includes('r1'), 'после отказа сервера продолжает');
});

// ── ОСЦИЛЛЯЦИЯ 2026-07-05: после фикса идемпотентности churn НЕ прекратился — 24 реликвии
// переодевались по 29-41 раз за 5 часов (ledger-Fury). Две причины: (1) сортировки pool/ranked
// нестабильны при равных скорах/рангах — порядок массивов из /api/player/load меняется от тика к
// тику → равноценные релики каждый раз раздаются в другом порядке; (2) уровни существ постоянно
// растут от данжей → ранги сдвигаются → жадный план перекидывает те же релики между соседями по
// рангу без реального выигрыша. Лечение: детерминированные тай-брейки по id + «липкость» к текущему
// носителю, когда выигрыш от переезда незначителен.
test('стабильность: равноценные релики, уже надетые на равноценных существ → пустой план при любом порядке массивов', () => {
  const mk = (id, on) => relic(id, 'hp_pct', 'Common', [{ key: 'hp_pct', value: 0.05 }],
    on ? { equipped_on: on, equip_slot: 'combat_a' } : {});
  const a = mk('ra', 'c1'), b = mk('rb', 'c2');
  const c1 = cr('c1', 'Adult', 6), c2 = cr('c2', 'Adult', 6);
  for (const [relics, creatures] of [
    [[a, b], [c1, c2]], [[b, a], [c1, c2]], [[a, b], [c2, c1]], [[b, a], [c2, c1]],
  ]) {
    const { equip, unequip } = planRelicEquip(relics, creatures);
    assert.equal(equip.length, 0, `порядок массивов не должен вызывать переэкипировку (equip=${JSON.stringify(equip)})`);
    assert.equal(unequip.length, 0);
  }
});

test('липкость: сдвиг рангов существ (кач уровней) не перекидывает равноценные релики между ними', () => {
  const mk = (id, on) => relic(id, 'hp_pct', 'Common', [{ key: 'hp_pct', value: 0.05 }],
    { equipped_on: on, equip_slot: 'combat_a' });
  const a = mk('ra', 'c1'), b = mk('rb', 'c2');
  // тик N: c1 сильнее; тик N+1: c2 перегнал по уровню — релики равны, переезд бессмысленен
  const before = planRelicEquip([a, b], [cr('c1', 'Adult', 6), cr('c2', 'Adult', 5)]);
  const after = planRelicEquip([a, b], [cr('c1', 'Adult', 6), cr('c2', 'Adult', 9)]);
  assert.equal(before.equip.length + before.unequip.length, 0);
  assert.equal(after.equip.length + after.unequip.length, 0, 'ранги сдвинулись, но выигрыша нет → нет действий');
});

// ── КАП СЛОТОВ 2026-07-05: живые дампы (Fury/Zephyr/main first-state) показывают МАКСИМУМ 3
// реликвии на существо — физические слоты сервера combat_a/b/c, типы статов свободно смешиваются.
// Планировщик же вешал по одной реликвии КАЖДОГО типа стата без общего лимита → на топ-существо
// планировалось 10+ реликвий; сервер отвечал 200, но сверх трёх не персистил — и каждый цикл те же
// «успешные» экипировки повторялись заново (Zephyr: daac2c33→ab0a7727 в 21:08, 21:19, 21:29).
test('сервер-кап: не планирует больше 3 реликвий на существо', () => {
  const relics = ['hp_pct', 'crit_dmg', 'ward', 'agi_pct', 'luck'].map((slot, i) =>
    relic('r' + i, slot, 'Common', [{ key: slot, value: 0.05 }]));
  const { equip } = planRelicEquip(relics, [cr('c1', 'Adult', 6)]);
  assert.equal(equip.length, 3, `максимум 3 на существо (got ${equip.length})`);
  // излишек уходит следующему по рангу существу, а не в никуда
  const two = planRelicEquip(relics, [cr('c1', 'Adult', 6), cr('c2', 'Juvenile', 5)]);
  const byTarget = {};
  for (const e of two.equip) byTarget[e.target] = (byTarget[e.target] || 0) + 1;
  assert.deepEqual(byTarget, { c1: 3, c2: 2 });
});

test('сервер-кап + идемпотентность: существо с полными 3 слотами и без апгрейдов → пустой план', () => {
  const worn = ['hp_pct', 'crit_dmg', 'ward'].map((slot, i) =>
    relic('w' + i, slot, 'Common', [{ key: slot, value: 0.05 }], { equipped_on: 'c1', equip_slot: 'combat_' + 'abc'[i] }));
  const spare = relic('sp', 'luck', 'Common', [{ key: 'luck', value: 0.05 }]); // равный скор — не апгрейд
  const { equip, unequip } = planRelicEquip([...worn, spare], [cr('c1', 'Adult', 6)]);
  assert.equal(equip.length, 0, `слоты полны, spare не лучше → нет действий (got ${JSON.stringify(equip)})`);
  assert.equal(unequip.length, 0);
});

test('липкость НЕ блокирует реальный апгрейд: заметно лучший свободный релик всё равно надевается', () => {
  const worn = relic('old', 'hp_pct', 'Common', [{ key: 'hp_pct', value: 0.05 }], { equipped_on: 'c1', equip_slot: 'combat_a' });
  const upgrade = relic('new', 'hp_pct', 'Rare', [{ key: 'hp_pct', value: 0.11 }]);
  const { equip, unequip } = planRelicEquip([worn, upgrade], [cr('c1', 'Adult', 6)]);
  assert.deepEqual(equip, [{ relicId: 'new', target: 'c1', slot: 'hp_pct' }]);
  assert.deepEqual(unequip, [{ relicId: 'old' }], 'старый снимается (в плане ему нет носителя)');
});

// ── handleRelicEnhance (2026-07-06, друг: качаем 3 Legendary trainer-реликвии «сразу на два
// уровня»): фильтр по классу (пет-реликвий 200+ — качать всех разорительно), гейт по золоту
// (защита egg/breed-бюджета) и потолок уровня. Плюс фикс видимости: trainer-реликвии маркируют
// экипировку через equip_slot БЕЗ equipped_on (носитель — тренер) — старый фильтр их не видел.
function makeEnhanceBot(cfg = {}) {
  const client = { address: 'Enhance1111111111111111111111111111111', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'enhance', ledger: false, persistStaminaPending: false, ...cfg });
  const enhanced = [];
  bot.act = async (path, body) => {
    if (path === '/api/relic/enhance') enhanced.push(body.relicId);
    return {};
  };
  return { bot, enhanced };
}

test('handleRelicEnhance качает trainer-реликвию с equip_slot но БЕЗ equipped_on (носитель — тренер)', async () => {
  const { bot, enhanced } = makeEnhanceBot();
  const trainerRelic = { id: 'tr1', class: 'trainer', slot: 'amulet', equipped_on: null, equip_slot: 'amulet',
    listed: false, stored: false, enhance_level: 0, affixes: [] };
  await bot.handleRelicEnhance({ player: { gold: 999_999 }, relics: [trainerRelic] });
  assert.deepEqual(enhanced, ['tr1'], 'equip_slot без equipped_on = надета на тренера, а не «не надета»');
});

test('handleRelicEnhance фильтрует по enhanceRelicClasses (null = все классы, как раньше)', async () => {
  const relics = [
    { id: 'pet', class: 'combat', equipped_on: 'c1', equip_slot: 'combat_a', listed: false, stored: false, enhance_level: 0 },
    { id: 'tr', class: 'trainer', equipped_on: null, equip_slot: 'ring', listed: false, stored: false, enhance_level: 0 },
  ];
  const only = makeEnhanceBot({ enhanceRelicClasses: ['trainer'] });
  await only.bot.handleRelicEnhance({ player: { gold: 999_999 }, relics });
  assert.deepEqual(only.enhanced, ['tr'], 'combat-реликвия отфильтрована');

  const all = makeEnhanceBot(); // enhanceRelicClasses: null (default)
  await all.bot.handleRelicEnhance({ player: { gold: 999_999 }, relics });
  assert.equal(all.enhanced.length, 2, 'null = старое поведение, качаем все классы');
});

test('handleRelicEnhance не качает реликвию с enhance_level ≥ enhanceMaxLevel', async () => {
  const { bot, enhanced } = makeEnhanceBot({ enhanceMaxLevel: 2 });
  const relics = [
    { id: 'maxed', class: 'trainer', equip_slot: 'amulet', listed: false, stored: false, enhance_level: 2 },
    { id: 'fresh', class: 'trainer', equip_slot: 'ring', listed: false, stored: false, enhance_level: 1 },
  ];
  await bot.handleRelicEnhance({ player: { gold: 999_999 }, relics });
  assert.deepEqual(enhanced, ['fresh'], '+2 уже достигнут → только недокачанная');
});

test('handleRelicEnhance гейтится enhanceMinGold (защита egg/breed-бюджета)', async () => {
  const relics = [{ id: 'tr', class: 'trainer', equip_slot: 'amulet', listed: false, stored: false, enhance_level: 0 }];

  const poor = makeEnhanceBot({ enhanceMinGold: 300_000 });
  await poor.bot.handleRelicEnhance({ player: { gold: 299_999 }, relics });
  assert.deepEqual(poor.enhanced, [], 'gold < enhanceMinGold → не качаем вовсе');

  const rich = makeEnhanceBot({ enhanceMinGold: 300_000 });
  await rich.bot.handleRelicEnhance({ player: { gold: 300_000 }, relics });
  assert.deepEqual(rich.enhanced, ['tr'], 'gold ≥ enhanceMinGold → качаем');
});

// ── planTrainerRelicEquip: тренер-реликвии (2026-07-05) — отдельная система от пет-реликвий:
// class≠'combat' (default 'trainer'), один носитель (сам тренер), фиксированные слоты, сравнение
// по статам (scoreRelic) вместо наивного "надень, что скрафтил" (owner: "фиксим чтоб вешалось
// на тренера — по статам что лучше").
const trelic = (id, slot, affixes, extra = {}) =>
  ({ id, class: 'trainer', slot, affixes, listed: false, stored: false, equipped_on: null, equip_slot: null, ...extra });

test('planTrainerRelicEquip: пустая коллекция / нет trainer-класса → ничего не делает', () => {
  assert.deepEqual(planTrainerRelicEquip([]), { equip: [], unequip: [] });
  const combatOnly = [{ id: 'c1', class: 'combat', slot: 'amulet', affixes: [{ key: 'x', value: 1 }] }];
  assert.deepEqual(planTrainerRelicEquip(combatOnly), { equip: [], unequip: [] }, 'combat-класс не считается тренерским');
});

test('planTrainerRelicEquip: надевает лучшую по статам реликвию в каждый слот', () => {
  const weak = trelic('w', 'amulet', [{ key: 'x', value: 0.05 }]);
  const strong = trelic('s', 'amulet', [{ key: 'x', value: 0.20 }]);
  const ring = trelic('r', 'ring', [{ key: 'y', value: 0.1 }]);
  const { equip, unequip } = planTrainerRelicEquip([weak, strong, ring]);
  assert.equal(unequip.length, 0);
  assert.deepEqual(equip.sort((a, b) => a.slot.localeCompare(b.slot)), [
    { relicId: 's', slot: 'amulet' },
    { relicId: 'r', slot: 'ring' },
  ], 'лучший amulet (s, не w) + единственный ring');
});

test('planTrainerRelicEquip: идемпотентность — уже надетая лучшая реликвия не переэкипируется', () => {
  const onTrainer = trelic('s', 'amulet', [{ key: 'x', value: 0.2 }], { equipped_on: 'trainer', equip_slot: 'amulet' });
  const { equip, unequip } = planTrainerRelicEquip([onTrainer]);
  assert.equal(equip.length, 0);
  assert.equal(unequip.length, 0);
});

test('planTrainerRelicEquip: заменяет хуже-надетую на лучшую (снять старую, надеть новую)', () => {
  const worse = trelic('w', 'amulet', [{ key: 'x', value: 0.05 }], { equipped_on: 'trainer', equip_slot: 'amulet' });
  const better = trelic('s', 'amulet', [{ key: 'x', value: 0.2 }]); // только что скована, ещё не надета
  const { equip, unequip } = planTrainerRelicEquip([worse, better]);
  assert.deepEqual(unequip, [{ relicId: 'w' }], 'снять худшую');
  assert.deepEqual(equip, [{ relicId: 's', slot: 'amulet' }], 'надеть лучшую');
});

test('planTrainerRelicEquip: НЕ ухудшает гир — свежескованная но более слабая реликвия не вытесняет надетую лучшую', () => {
  // Регрессия найденного бага: старый handleForgeTrainerRelic слепо надевал ЛЮБУЮ только что
  // скованную реликвию, даже более слабую, чем уже надетая — снижая party-power тренера.
  const equippedBetter = trelic('s', 'amulet', [{ key: 'x', value: 0.2 }], { equipped_on: 'trainer', equip_slot: 'amulet' });
  const freshlyForgedWorse = trelic('new', 'amulet', [{ key: 'x', value: 0.05 }]);
  const { equip, unequip } = planTrainerRelicEquip([equippedBetter, freshlyForgedWorse]);
  assert.equal(equip.length, 0, 'не надевает более слабую свежую реликвию');
  assert.equal(unequip.length, 0, 'не снимает уже надетую лучшую');
});

test('planTrainerRelicEquip: пропускает listed/stored реликвии и уважает кастомный trainerClass', () => {
  const listed = trelic('l', 'amulet', [{ key: 'x', value: 0.5 }], { listed: true });
  const stored = trelic('st', 'amulet', [{ key: 'x', value: 0.5 }], { stored: true });
  const valid = trelic('v', 'amulet', [{ key: 'x', value: 0.05 }]);
  const { equip } = planTrainerRelicEquip([listed, stored, valid]);
  assert.deepEqual(equip, [{ relicId: 'v', slot: 'amulet' }]);

  const customClass = { id: 'c', class: 'persona', slot: 'ring', affixes: [{ key: 'y', value: 0.1 }], listed: false, stored: false };
  assert.deepEqual(planTrainerRelicEquip([customClass], { trainerClass: 'persona' }).equip, [{ relicId: 'c', slot: 'ring' }]);
});

test('интеграция: handleTrainerRelics шлёт unequip перед equip, троттлится, best-effort при отказе', async () => {
  const client = { address: 'Trainer111111111111111111111111111111', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'trainer', ledger: false, persistStaminaPending: false, autoEquipTrainerRelics: true });
  const calls = [];
  bot.act = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/relic/equip' && body.relicId === 'bad') { const e = new Error('bad'); e.status = 400; throw e; }
    return {};
  };
  const worse = trelic('w', 'amulet', [{ key: 'x', value: 0.05 }], { equipped_on: 'trainer', equip_slot: 'amulet' });
  const better = trelic('s', 'amulet', [{ key: 'x', value: 0.2 }]);
  await bot.handleTrainerRelics({ relics: [worse, better] });

  const unequips = calls.filter(c => c.path === '/api/relic/unequip').map(c => c.body.relicId);
  const equips = calls.filter(c => c.path === '/api/relic/equip').map(c => c.body);
  assert.deepEqual(unequips, ['w']);
  assert.deepEqual(equips, [{ relicId: 's', slot: 'amulet' }], 'equip не содержит target — у тренера нет "цели"-существа');

  const before = calls.length;
  await bot.handleTrainerRelics({ relics: [worse, better] });
  assert.equal(calls.length, before, 'повторный вызов в окне троттла ничего не шлёт');
});

test('интеграция: handleTrainerRelics не падает при пустых/отсутствующих relics', async () => {
  const client = { address: 'Trainer222222222222222222222222222222', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'trainer2', ledger: false, persistStaminaPending: false });
  bot.act = async () => { throw new Error('should not be called'); };
  await bot.handleTrainerRelics({}); // relics отсутствует вовсе
  await bot.handleTrainerRelics({ relics: [] });
});

test('интеграция: handleTrainerRelics выключается через autoEquipTrainerRelics:false', async () => {
  const client = { address: 'Trainer333333333333333333333333333333', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'trainer3', ledger: false, persistStaminaPending: false, autoEquipTrainerRelics: false });
  // handleTrainerRelics сам по себе не гейтится флагом (это делает вызывающий tick()) — здесь
  // просто проверяем, что prefDungeonActions не подключает его, косвенно — что флаг существует и readable.
  assert.equal(bot.cfg.autoEquipTrainerRelics, false);
});

test('интеграция: handleRelics троттлится', async () => {
  const client = { address: 'Relic22222222222222222222222222222222', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, { name: 'relic2', ledger: false, persistStaminaPending: false });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  const relics = [r_hp_rare];
  const creatures = [cr('c1', 'Adult', 6)];
  await bot.handleRelics({ relics, creatures });
  const n = calls.length;
  await bot.handleRelics({ relics, creatures }); // сразу — троттл
  assert.equal(calls.length, n, 'повторный вызов в окне троттла ничего не шлёт');
});

// БАТЧ-КАП 2026-07-06 (owner: «ускорит фарм» после найденного бага идемпотентности): большой разовый
// бэклог релик-экипировки не должен съедать весь тик и блокировать dispatchRuns/данжи — обрабатываем
// не больше relicMaxActionsPerTick действий за вызов, остальное — на следующий (после relicRetryMs).
test('интеграция: relicMaxActionsPerTick режет большой план на батчи, не теряя остаток', async () => {
  const client = { address: 'Relic44444444444444444444444444444444', wallet: {}, api: async () => ({}) };
  const bot = new ZenkoBot(client, {
    name: 'relic4', ledger: false, persistStaminaPending: false, relicMaxActionsPerTick: 2,
  });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  // 5 разных stat-slot'ов на двух существах (кап 3/существо) → planRelicEquip хочет 5 equip за проход
  const relics = [
    relic('r1', 'hp_pct', 'Common', [{ key: 'hp_pct', value: 0.01 }]),
    relic('r2', 'crit_dmg', 'Common', [{ key: 'crit_dmg', value: 0.01 }]),
    relic('r3', 'luck', 'Common', [{ key: 'luck', value: 0.01 }]),
    relic('r4', 'agi_pct', 'Common', [{ key: 'agi_pct', value: 0.01 }]),
    relic('r5', 'ward', 'Common', [{ key: 'ward', value: 0.01 }]),
  ];
  const creatures = [cr('c1', 'Adult', 6), cr('c2', 'Juvenile', 5)];

  await bot.handleRelics({ relics, creatures });
  const firstBatch = calls.filter(c => c.path === '/api/relic/equip');
  assert.equal(firstBatch.length, 2, `first call sends only relicMaxActionsPerTick(2) actions (got ${firstBatch.length})`);

  // симулируем "прошло 10 мин" — обходим throttle, как это сделал бы следующий реальный тик
  bot.nextRelicAt = 0;
  // предположим, что r1/r2 сервер уже подтвердил (равно тому, что вернёт следующий /api/player/load)
  const relicsAfterFirstBatch = relics.map(r =>
    firstBatch.some(c => c.body.relicId === r.id) ? { ...r, equipped_on: 'c1', equip_slot: 'combat_x' } : r);
  await bot.handleRelics({ relics: relicsAfterFirstBatch, creatures });
  const secondBatch = calls.filter(c => c.path === '/api/relic/equip').slice(firstBatch.length);
  assert.equal(secondBatch.length, 2, `second call picks up more of the deferred backlog (got ${secondBatch.length})`);
  assert.ok(secondBatch.every(c => !firstBatch.some(f => f.body.relicId === c.body.relicId)),
    'second batch does not re-send relics already confirmed equipped in the first batch');
});
