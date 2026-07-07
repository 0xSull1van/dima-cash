import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBreedPair, isBreedEligible, breedCooldownElapsed, speciesKey, breedIneligibleReason, describeBreedSkip } from '../src/breeding.js';

const NOW = Date.parse('2026-07-04T20:00:00Z');
const ago = (min) => new Date(NOW - min * 60 * 1000).toISOString();
// happy Adult, off cooldown, cap not reached — the baseline eligible parent
const base = (over = {}) => ({
  id: 'x', creature_id: 'quartzpup', rarity: 'Uncommon', stage: 'Adult',
  happiness: 100, breed_count: 0, last_breed_time: null, level: 5, ...over,
});

test('isBreedEligible: baseline Adult passes', () => {
  assert.equal(isBreedEligible(base(), {}, NOW), true);
});

test('isBreedEligible: gates stage, happiness, cap, cooldown, rarity, protections', () => {
  assert.equal(isBreedEligible(base({ stage: 'Juvenile' }), {}, NOW), false, 'Juvenile blocked');
  assert.equal(isBreedEligible(base({ stage: 'Baby' }), {}, NOW), false, 'Baby blocked');
  assert.equal(isBreedEligible(base({ happiness: 49 }), {}, NOW), false, 'happiness<50 blocked');
  assert.equal(isBreedEligible(base({ breed_count: 8 }), {}, NOW), false, 'cap reached blocked');
  assert.equal(isBreedEligible(base({ last_breed_time: ago(5) }), {}, NOW), false, 'on 25m cooldown blocked');
  assert.equal(isBreedEligible(base({ last_breed_time: ago(26) }), {}, NOW), true, 'past cooldown ok');
  assert.equal(isBreedEligible(base({ rarity: 'Legendary' }), {}, NOW), false, 'Legendary blocked (>breedMaxRarity epic)');
  assert.equal(isBreedEligible(base({ rarity: 'Epic' }), {}, NOW), true, 'Epic allowed by default ceiling');
  assert.equal(isBreedEligible(base({ is_favorite: true }), {}, NOW), false, 'favorite protected');
  assert.equal(isBreedEligible(base({ listed: true }), {}, NOW), false, 'listed blocked');
  // 2026-07-05: vaulted (stored) creatures are ALLOWED to breed by default (owner: "с сейфа
  // придить" — zero opportunity cost, they don't run dungeons anyway). Opt-out via breedAllowStored:false.
  assert.equal(isBreedEligible(base({ stored: true }), {}, NOW), true, 'vaulted allowed by default');
  assert.equal(isBreedEligible(base({ stored: true }), { breedAllowStored: false }, NOW), false, 'vaulted blocked when explicitly disabled');
});

test('breedCooldownElapsed: null/old elapsed, recent not', () => {
  assert.equal(breedCooldownElapsed({ last_breed_time: null }, NOW, 25 * 60 * 1000), true);
  assert.equal(breedCooldownElapsed({ last_breed_time: ago(30) }, NOW, 25 * 60 * 1000), true);
  assert.equal(breedCooldownElapsed({ last_breed_time: ago(10) }, NOW, 25 * 60 * 1000), false);
});

// 2026-07-06: grouping key changed from SPECIES to RARITY (friend: "рарки с рарками, эпики с эпиками";
// wiki confirms tier/element — not species and not rarity — is the server's real rule, but we can't
// read tier/element at all, so rarity is the adopted proxy — same-species is still preferred WITHIN a
// rarity when available, purely because it's zero-risk, not because it's required anymore).
test('planBreedPair: needs two same-RARITY eligible (species no longer required — only preferred)', () => {
  // two different rarities, one each → no pair (nothing shares a rarity to group on)
  const none = planBreedPair([
    base({ id: 'a', creature_id: 'quartzpup', rarity: 'Uncommon' }),
    base({ id: 'b', creature_id: 'seedlup', rarity: 'Rare' }),
  ], {}, NOW);
  assert.equal(none, null);
  // two of same species (→ same rarity too) → pair, label is just the one species
  const same = planBreedPair([
    base({ id: 'a', creature_id: 'quartzpup' }),
    base({ id: 'b', creature_id: 'quartzpup' }),
  ], {}, NOW);
  assert.ok(same && same.species === 'quartzpup');
  assert.deepEqual(new Set(same.pair.map((c) => c.id)), new Set(['a', 'b']));
});

// 2026-07-06 follow-up (friend, fuller statement): "одна порода, одна рарность, один тир, у обоих —
// если разное будет то −уровень" — cross-species is tolerated by the server but confirmed WORSE, so
// the cross-species fallback is opt-in (breedAllowCrossSpecies:true), OFF by default.
test('planBreedPair: cross-species same-rarity pairing is OFF by default (owner: "одна порода... у обоих")', () => {
  const plan = planBreedPair([
    base({ id: 'a', creature_id: 'quartzpup', rarity: 'Rare' }),
    base({ id: 'b', creature_id: 'seedlup', rarity: 'Rare' }),
  ], {}, NOW);
  assert.equal(plan, null, 'no same-species duplicate at Rare, and cross-species fallback is disabled by default → no pair rather than a known-worse one');
});

test('planBreedPair: breedAllowCrossSpecies:true opts back into the cross-species fallback', () => {
  const plan = planBreedPair([
    base({ id: 'a', creature_id: 'quartzpup', rarity: 'Rare' }),
    base({ id: 'b', creature_id: 'seedlup', rarity: 'Rare' }),
  ], { breedAllowCrossSpecies: true }, NOW);
  assert.ok(plan, 'explicitly opted in → same-rarity cross-species pair is allowed');
  assert.equal(plan.species, 'quartzpup/seedlup', 'label carries both species names for a cross-species pair');
  assert.deepEqual(new Set(plan.pair.map((c) => c.id)), new Set(['a', 'b']));
});

test('planBreedPair: a same-species duplicate at a rarity is preferred over a cross-species pair there', () => {
  const plan = planBreedPair([
    base({ id: 'q1', creature_id: 'quartzpup', rarity: 'Rare' }),
    base({ id: 'q2', creature_id: 'quartzpup', rarity: 'Rare' }),
    base({ id: 's1', creature_id: 'seedlup', rarity: 'Rare' }), // lone — would only pair cross-species
  ], {}, NOW);
  assert.equal(plan.species, 'quartzpup', 'zero-risk same-species duplicate wins over reaching for the lone cross-species candidate');
  assert.deepEqual(new Set(plan.pair.map((c) => c.id)), new Set(['q1', 'q2']));
});

test('planBreedPair: bottom-up — prefers LOWER min-rarity first (friend strategy)', () => {
  const plan = planBreedPair([
    base({ id: 'u1', creature_id: 'unc1', rarity: 'Uncommon' }),
    base({ id: 'u2', creature_id: 'unc1', rarity: 'Uncommon' }),
    base({ id: 'r1', creature_id: 'rare1', rarity: 'Rare' }),
    base({ id: 'r2', creature_id: 'rare1', rarity: 'Rare' }),
  ], {}, NOW);
  assert.equal(plan.species, 'unc1', 'uncommon bred before rare (uncommon→rare→epic)');
  assert.equal(plan.minRarity, 'uncommon');
  assert.equal(plan.estCostGold, 10000);
});

// 2026-07-07 (owner: эпики/леги растут медленно — bottom-up starved the scarce high tiers): flip to HIGH-first.
test('planBreedPair: breedHighRarityFirst — prefers HIGHER min-rarity (climb epics/legs)', () => {
  const plan = planBreedPair([
    base({ id: 'u1', creature_id: 'unc1', rarity: 'Uncommon' }),
    base({ id: 'u2', creature_id: 'unc1', rarity: 'Uncommon' }),
    base({ id: 'r1', creature_id: 'rare1', rarity: 'Rare' }),
    base({ id: 'r2', creature_id: 'rare1', rarity: 'Rare' }),
    base({ id: 'e1', creature_id: 'ep1', rarity: 'Epic' }),
    base({ id: 'e2', creature_id: 'ep1', rarity: 'Epic' }),
  ], { breedHighRarityFirst: true }, NOW);
  assert.equal(plan.species, 'ep1', 'epic pair bred first — the scarce high tier climbs, uncommons fill the rest of the tick');
  assert.equal(plan.minRarity, 'epic');
});

test('planBreedPair: breedMinRarity excludes Common (Common = XP fodder, not bred)', () => {
  const roster = [
    base({ id: 'c1', creature_id: 'com', rarity: 'Common' }),
    base({ id: 'c2', creature_id: 'com', rarity: 'Common' }),
  ];
  assert.equal(planBreedPair(roster, { breedMinRarity: 'uncommon' }, NOW), null, 'no common pair when min=uncommon');
  assert.ok(planBreedPair(roster, { breedMinRarity: 'common' }, NOW), 'common pair allowed when min=common');
});

test('isBreedEligible: breedMinRarity floor', () => {
  assert.equal(isBreedEligible(base({ rarity: 'Common' }), { breedMinRarity: 'uncommon' }, NOW), false, 'Common blocked when min=uncommon');
  assert.equal(isBreedEligible(base({ rarity: 'Common' }), {}, NOW), true, 'Common allowed by default min=common');
});

test('planBreedPair: picks lowest (stage,level) parents within a species', () => {
  const plan = planBreedPair([
    base({ id: 'hi', creature_id: 'q', stage: 'Elder', level: 30 }),
    base({ id: 'lo1', creature_id: 'q', stage: 'Adult', level: 3 }),
    base({ id: 'lo2', creature_id: 'q', stage: 'Adult', level: 5 }),
  ], {}, NOW);
  assert.deepEqual(new Set(plan.pair.map((c) => c.id)), new Set(['lo1', 'lo2']), 'keeps the strong Elder as a runner');
});

// 2026-07-05 owner: "можно же с сейфа придить" (breed from vault) — vaulted creatures have ZERO
// opportunity cost (they already don't run dungeons), so they should be picked as parents BEFORE any
// active creature, even one that's lower stage/level (which still has SOME small chance of running).
test('planBreedPair: prefers STORED (vaulted) parents over active ones, even higher-level vaulted ones', () => {
  const plan = planBreedPair([
    base({ id: 'active_low', creature_id: 'q', stage: 'Adult', level: 3 }),        // lowest level, but active
    base({ id: 'vaulted_high', creature_id: 'q', stage: 'Elder', level: 40, stored: true }), // vaulted, high level
    base({ id: 'vaulted_low', creature_id: 'q', stage: 'Adult', level: 5, stored: true }),   // vaulted, lower level
  ], {}, NOW);
  assert.deepEqual(new Set(plan.pair.map((c) => c.id)), new Set(['vaulted_low', 'vaulted_high']),
    `both vaulted parents chosen over the active one, even though active has lower level (got ${JSON.stringify(plan.pair.map(c => c.id))})`);
});

test('planBreedPair: falls back to active (stage,level) ordering when no vaulted candidates exist', () => {
  const plan = planBreedPair([
    base({ id: 'hi', creature_id: 'q', stage: 'Elder', level: 30 }),
    base({ id: 'lo', creature_id: 'q', stage: 'Adult', level: 3 }),
  ], {}, NOW);
  assert.deepEqual(new Set(plan.pair.map((c) => c.id)), new Set(['hi', 'lo']), 'only 2 candidates, none vaulted — normal pairing');
});

test('planBreedPair: excludes busy (in-run) creatures', () => {
  const plan = planBreedPair([
    base({ id: 'run', creature_id: 'q' }),
    base({ id: 'idle', creature_id: 'q' }),
  ], { busyIds: new Set(['run']) }, NOW);
  assert.equal(plan, null, 'only one idle same-species → no pair');
});

test('planBreedPair: an on-cooldown parent cannot complete a pair', () => {
  const plan = planBreedPair([
    base({ id: 'ok', creature_id: 'q', last_breed_time: null }),
    base({ id: 'cd', creature_id: 'q', last_breed_time: ago(5) }),
  ], {}, NOW);
  assert.equal(plan, null);
});

test('planBreedPair: prefers UNBOUND parents (sellable offspring) at same rarity', () => {
  const plan = planBreedPair([
    base({ id: 'b1', creature_id: 'q', rarity: 'Uncommon', bound: true }),
    base({ id: 'b2', creature_id: 'q', rarity: 'Uncommon', bound: true }),
    base({ id: 'u1', creature_id: 'w', rarity: 'Uncommon', bound: false }),
    base({ id: 'u2', creature_id: 'w', rarity: 'Uncommon', bound: false }),
  ], {}, NOW);
  assert.equal(plan.species, 'w', 'unbound pair chosen over bound pair (tradeable offspring)');
  assert.equal(plan.pairUnbound, true);
});

test('planBreedPair: within a species, skips a bound member to keep the pair unbound', () => {
  const plan = planBreedPair([
    base({ id: 'bd', creature_id: 'q', rarity: 'Uncommon', bound: true, level: 1 }),
    base({ id: 'ub1', creature_id: 'q', rarity: 'Uncommon', bound: false, level: 5 }),
    base({ id: 'ub2', creature_id: 'q', rarity: 'Uncommon', bound: false, level: 6 }),
  ], {}, NOW);
  assert.deepEqual(new Set(plan.pair.map((c) => c.id)), new Set(['ub1', 'ub2']), 'skips bound even though it is lowest-level');
  assert.equal(plan.pairUnbound, true);
});

test('planBreedPair: falls back to a bound pair when no unbound pair exists (climb still works)', () => {
  const plan = planBreedPair([
    base({ id: 'b1', creature_id: 'q', rarity: 'Uncommon', bound: true }),
    base({ id: 'b2', creature_id: 'q', rarity: 'Uncommon', bound: true }),
  ], {}, NOW);
  assert.ok(plan, 'bound pair still bred (tier climb works; offspring goes to XP)');
  assert.equal(plan.pairUnbound, false);
});

test('speciesKey falls back creature_id→species', () => {
  assert.equal(speciesKey({ creature_id: 'Nimbu' }), 'nimbu');
  assert.equal(speciesKey({ species: 'Florix' }), 'florix');
});

// DIAGNOSTIC visibility 2026-07-05: added while investigating "breed silent for 4h on 3-4 accounts
// with an apparent valid same-species pair" — happiness/last_breed_time aren't in the dashboard's
// trimmed creaturesList, so there was no way to tell "no pair" from "pair exists but happiness/
// cooldown/silent-400 blocks it" without adding this. isBreedEligible is now a thin wrapper over this.
test('breedIneligibleReason: single source of truth, matches isBreedEligible exactly', () => {
  assert.equal(breedIneligibleReason(base()), null, 'eligible → null reason');
  assert.equal(breedIneligibleReason(base({ stage: 'Juvenile' })), 'stage<Adult');
  assert.equal(breedIneligibleReason(base({ happiness: 30 })), 'happiness<50');
  assert.equal(breedIneligibleReason(base({ breed_count: 8 })), 'breed_count>=cap');
  assert.equal(breedIneligibleReason(base({ last_breed_time: ago(5) }), {}, NOW), 'cooldown');
  assert.equal(breedIneligibleReason(base({ rarity: 'Common' })), null, 'default breedMinRarity is "common" itself, so Common passes with no cfg override');
  assert.equal(breedIneligibleReason(base({ rarity: 'Common' }), { breedMinRarity: 'uncommon' }), 'rarity<min', 'explicit breedMinRarity gates Common out');
  assert.equal(breedIneligibleReason(base({ rarity: 'Legendary' })), 'rarity>max');
  assert.equal(breedIneligibleReason(base({ is_favorite: true })), 'favorite');
  assert.equal(breedIneligibleReason(base({ listed: true })), 'listed');
  assert.equal(breedIneligibleReason(base({ stored: true })), null, 'vaulted eligible by default (2026-07-05)');
  assert.equal(breedIneligibleReason(base({ stored: true }), { breedAllowStored: false }), 'stored');
  assert.equal(breedIneligibleReason(null), 'missing');
  // isBreedEligible must stay exactly consistent with this (no drift between the two)
  for (const over of [{}, { stage: 'Baby' }, { happiness: 0 }, { breed_count: 8 }, { is_favorite: true }]) {
    assert.equal(isBreedEligible(base(over)), breedIneligibleReason(base(over)) === null, `isBreedEligible/breedIneligibleReason agree for ${JSON.stringify(over)}`);
  }
});

// 2026-07-06: describeBreedSkip now groups by RARITY (matches planBreedPair) — the label is the
// rarity name, not a species name; 'lone' needs a genuinely DIFFERENT rarity to stay excluded.
test('describeBreedSkip: reports the largest same-rarity group and each member\'s reason', () => {
  const roster = [
    base({ id: 'c1', creature_id: 'craggle', happiness: 20 }),   // low happiness
    base({ id: 'c2', creature_id: 'craggle', last_breed_time: ago(5) }), // on cooldown
    base({ id: 'lone', creature_id: 'owl', rarity: 'Rare' }), // different rarity, not part of the reported group
  ];
  const detail = describeBreedSkip(roster, {}, NOW);
  assert.match(detail, /uncommon×2/, 'names the rarity and count');
  assert.match(detail, /happiness<50/, 'reports the low-happiness member');
  assert.match(detail, /cooldown/, 'reports the on-cooldown member');
});

test('describeBreedSkip: reports busyIds-excluded members as "busy"', () => {
  const roster = [
    base({ id: 'run1', creature_id: 'fox' }),
    base({ id: 'run2', creature_id: 'fox' }),
  ];
  const detail = describeBreedSkip(roster, { busyIds: new Set(['run1', 'run2']) }, NOW);
  assert.match(detail, /uncommon×2/);
  assert.match(detail, /busy,busy/, 'both busy-excluded members reported as busy, not their own eligibility gate');
});

test('describeBreedSkip: null when no rarity has 2+ creatures at all (matches "no pair" vs "pair blocked")', () => {
  assert.equal(describeBreedSkip([base({ id: 'a', creature_id: 'fox', rarity: 'Uncommon' }), base({ id: 'b', creature_id: 'owl', rarity: 'Rare' })], {}, NOW), null);
  assert.equal(describeBreedSkip([], {}, NOW), null);
});

test('describeBreedSkip: picks the LARGEST group when multiple rarities have duplicates', () => {
  const roster = [
    base({ id: 'a1', creature_id: 'fox', rarity: 'Uncommon' }), base({ id: 'a2', creature_id: 'fox', rarity: 'Uncommon' }),
    base({ id: 'b1', creature_id: 'owl', rarity: 'Rare' }), base({ id: 'b2', creature_id: 'owl', rarity: 'Rare' }), base({ id: 'b3', creature_id: 'owl', rarity: 'Rare' }),
  ];
  assert.match(describeBreedSkip(roster, {}, NOW), /rare×3/, 'reports the 3-member group, not the 2-member one');
});

// ── МУЛЬТИ-БРИД ЗА ТИК 2026-07-06 (закрытие вопроса с бридингом): пул из 10 бридеров в сейфе =
// до 5 готовых пар, а handleBreed делал ОДНУ попытку раз в breedRetryMs (10 мин) — остальные пары
// простаивали готовыми. Теперь до breedMaxPerTick пар за вызов (использованные родители исключаются
// из следующего planBreedPair через busyIds). Человечно: игрок, открыв сейф, бридит все готовые
// пары подряд, а не одну за визит.
import { ZenkoBot } from '../src/bot.js';

const mkBot = (cfg = {}) => {
  const client = { address: 'Breed11111111111111111111111111111111', wallet: {}, api: async () => ({}) };
  return new ZenkoBot(client, { name: 'breedt', ledger: false, persistStaminaPending: false, autoBreed: true, ...cfg });
};

test('handleBreed: бридит до breedMaxPerTick пар за вызов, родители не переиспользуются', async () => {
  const bot = mkBot({ breedMaxPerTick: 2 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return { bredSuccess: true }; };
  const roster = [
    base({ id: 'a1', creature_id: 'fox' }), base({ id: 'a2', creature_id: 'fox' }),
    base({ id: 'b1', creature_id: 'owl' }), base({ id: 'b2', creature_id: 'owl' }),
    base({ id: 'c1', creature_id: 'elk' }), base({ id: 'c2', creature_id: 'elk' }),
  ];
  await bot.handleBreed({ player: { gold: 500000 }, creatures: roster, eggs: [] });
  const breeds = calls.filter(c => c.path === '/api/breed');
  assert.equal(breeds.length, 2, `ровно breedMaxPerTick(2) бридов за вызов (got ${breeds.length})`);
  const parents = breeds.flatMap(c => [c.body.parentA, c.body.parentB]);
  assert.equal(new Set(parents).size, 4, 'все 4 родителя уникальны — пары не пересекаются');
});

test('handleBreed: дефолт breedMaxPerTick=1 сохраняет старое поведение', async () => {
  const bot = mkBot();
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return { bredSuccess: true }; };
  const roster = [
    base({ id: 'a1', creature_id: 'fox' }), base({ id: 'a2', creature_id: 'fox' }),
    base({ id: 'b1', creature_id: 'owl' }), base({ id: 'b2', creature_id: 'owl' }),
  ];
  await bot.handleBreed({ player: { gold: 500000 }, creatures: roster, eggs: [] });
  assert.equal(calls.filter(c => c.path === '/api/breed').length, 1);
});

test('handleBreed: мульти-брид уважает инкубаторный кап нарастающе (каждый брид добавляет pending-яйцо)', async () => {
  // кап 6, уже 5 непроваренных breeding-яиц → влезает только ОДИН брид, не breedMaxPerTick
  const bot = mkBot({ breedMaxPerTick: 3, breedMaxPendingEggs: 6 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return { bredSuccess: true }; };
  const eggs = Array.from({ length: 5 }, (_, i) => ({ id: 'e' + i, egg_type: 'breeding', status: 'incubating' }));
  const roster = [
    base({ id: 'a1', creature_id: 'fox' }), base({ id: 'a2', creature_id: 'fox' }),
    base({ id: 'b1', creature_id: 'owl' }), base({ id: 'b2', creature_id: 'owl' }),
  ];
  await bot.handleBreed({ player: { gold: 500000 }, creatures: roster, eggs });
  assert.equal(calls.filter(c => c.path === '/api/breed').length, 1, 'кап 6 при 5 pending → один брид');
});

test('handleBreed: голда кончилась между парами — цикл останавливается, не уходит ниже резерва', async () => {
  // 25k голды, брид ~10k (uncommon), резерв 5k → первая пара ок (остаток 15k), вторая ок (5k=резерв), третья нет
  const bot = mkBot({ breedMaxPerTick: 5, breedGoldReserve: 5000 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return { bredSuccess: true }; };
  const roster = [
    base({ id: 'a1', creature_id: 'fox' }), base({ id: 'a2', creature_id: 'fox' }),
    base({ id: 'b1', creature_id: 'owl' }), base({ id: 'b2', creature_id: 'owl' }),
    base({ id: 'c1', creature_id: 'elk' }), base({ id: 'c2', creature_id: 'elk' }),
  ];
  await bot.handleBreed({ player: { gold: 25000 }, creatures: roster, eggs: [] });
  assert.equal(calls.filter(c => c.path === '/api/breed').length, 2, '25k − 2×10k = 5k = резерв → стоп');
});

// ── СЕЙФ-ЯСЛИ 2026-07-06 (owner: «бридить всех, и с сейфа и с флота; на яйца хватит места»):
// найдено вживую — ростер 50/50, все клапаны бессильны (коммоны переработаны, анкамоны защищены до
// 8/8, Rare+-клапан их не видит), hatch squad-full, ready-яйца ЧАСАМИ держат инкубатор, брид стоит.
// pickBreedingIntake теперь берёт в сейф существ ЛЮБОЙ стадии (Baby дозревает в сейфе — кормёжка и
// эволюция ходят по allCreatures) и bound (бридится, продавать всё равно нельзя); handleVaultIntake
// впускает батчами до vaultIntakeMaxPerTick.
import { pickBreedingIntake } from '../src/marketplace.js';

test('pickBreedingIntake: берёт Baby и bound (ясли), не только Adult+/unbound', () => {
  const baby = { id: 'b1', rarity: 'Uncommon', stage: 'Baby', breed_count: 0, bound: true };
  assert.equal(pickBreedingIntake([baby], {}, {})?.id, 'b1', 'Baby+bound проходит в сейф');
  const spent = { id: 's1', rarity: 'Uncommon', stage: 'Adult', breed_count: 8 };
  assert.equal(pickBreedingIntake([spent], {}, {}), null, 'исчерпанный 8/8 — на продажу, не в сейф');
  const stored = { id: 'st1', rarity: 'Uncommon', stage: 'Baby', breed_count: 0, stored: true };
  assert.equal(pickBreedingIntake([stored], {}, {}), null, 'уже в сейфе — не дублируем');
});

test('handleVaultIntake: батч до vaultIntakeMaxPerTick, без повторов, стоп на цели пула', async () => {
  const bot = mkBot({ autoBreedingPipeline: true, vaultIntakeMaxPerTick: 3, vaultBreedingPoolTarget: 2, vaultBreedingRarities: ['uncommon'] });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  const roster = Array.from({ length: 5 }, (_, i) => ({ id: 'u' + i, rarity: 'Uncommon', stage: 'Baby', breed_count: 0 }));
  await bot.handleVaultIntake({ player: {}, creatures: roster, eggs: [] });
  const moves = calls.filter(c => c.path === '/api/storage/move');
  assert.equal(moves.length, 2, `цель пула 2 (< батча 3) → ровно 2 впуска (got ${moves.length})`);
  assert.equal(new Set(moves.map(m => m.body.itemId)).size, 2, 'без повторов');
});

test('handleEvolve: видит вейвленных (сейф-ясли) через allCreatures', async () => {
  const bot = mkBot({});
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  const state = {
    player: { gold: 100000 },
    creatures: [],
    // creature_xp — реальное имя поля (старое `xp: 500` здесь само воспроизводило баг
    // несуществующего поля, из-за которого эволюция стояла днями)
    stored: { creatures: [{ id: 'vb1', stage: 'Baby', creature_xp: 500, quick_evolved: false, stored: true }] },
  };
  await bot.handleEvolve(state);
  assert.ok(calls.some(c => c.path === '/api/storage/move' && c.body.itemId === 'vb1' && c.body.store === false), 'сначала вынимает из сейфа (сервер запрещает evolve в сторадже)');
  assert.ok(calls.some(c => c.path === '/api/creature/evolve' && c.body.creatureId === 'vb1'), 'эволюция пробует вейвленного Baby');
});

// ── LUX 2026-07-06 (owner: «смотри чтоб петты были Lux»; друг: «люкс с люксом»): species — единственный
// маркер элемента в API. Lux-лестница стартует с COMMON (glimra/lumen → Gleamguard T1), покупных
// lux-Uncommon яиц не существует → lux-коммоны освобождены от breedMinRarity, защищены от XP-ножа,
// первыми заходят в ясли и не продаются.
import { isLuxCreature } from '../src/breeding.js';
import { pickRecycleFodder, pickJunkCreatures } from '../src/marketplace.js';

test('lux: breedMinRarity=uncommon НЕ блокирует lux-коммона; обычный коммон блокирует', () => {
  const cfg = { breedMinRarity: 'uncommon' };
  assert.equal(isBreedEligible(base({ creature_id: 'glimra', rarity: 'Common' }), cfg, NOW), true, 'glimra (lux) бридится');
  assert.equal(isBreedEligible(base({ creature_id: 'cobble', rarity: 'Common' }), cfg, NOW), false, 'обычный коммон — нет');
  assert.equal(isBreedEligible(base({ creature_id: 'glimra', rarity: 'Common' }), { ...cfg, breedLuxAnyRarity: false }, NOW), false, 'отключаемо');
});

test('lux: pickRecycleFodder не жертвует lux-коммонов', () => {
  const lux = { id: 'lx', creature_id: 'lumen', rarity: 'Common', variant: 'Normal' };
  const plain = { id: 'pl', creature_id: 'cobble', rarity: 'Common', variant: 'Normal' };
  const out = pickRecycleFodder([lux, plain], { recycleFodderRarities: ['common'] });
  assert.deepEqual(out.map(c => c.id), ['pl'], 'lux защищён, обычный — фоддер');
});

test('lux: pickJunkCreatures не продаёт lux даже выдохшегося', () => {
  const spent = { id: 'lx', creature_id: 'gleamguard', species: 'gleamguard', rarity: 'Uncommon', stage: 'Adult', variant: 'Normal', breed_count: 8 };
  const out = pickJunkCreatures([spent], { junkCreatureRarities: ['uncommon'], junkCreatureStages: ['Adult'], junkMinBreedCount: 8, junkCreatureKeepPerSpecies: 0 });
  assert.equal(out.length, 0, 'lux не товар — стратегический сток');
});

// 2026-07-07 (owner: "рарные common, типо shadow — тоже конвертились"): recycleCommonVariantsToXp recycles
// Golden/Shadow COMMONS to XP (a common is a common regardless of trait), keeping only the Rainbow jackpot.
test('recycleCommonVariantsToXp: Golden/Shadow commons → XP, Rainbow common kept, higher rarities protected', () => {
  const roster = [
    { id: 'shadowC', rarity: 'Common', variant: 'Shadow' },
    { id: 'goldC', rarity: 'Common', variant: 'Golden' },
    { id: 'rainbowC', rarity: 'Common', variant: 'Rainbow' },   // jackpot — kept
    { id: 'shadowU', rarity: 'Uncommon', variant: 'Shadow', breed_count: 8 }, // higher rarity → still protected
  ];
  const cfg = { recycleFodderRarities: ['common'], recycleExhaustedRarities: ['uncommon'], breedMaxCount: 8, recycleCommonVariantsToXp: true };
  const out = pickRecycleFodder(roster, cfg).map(c => c.id).sort();
  assert.deepEqual(out, ['goldC', 'shadowC'], 'Golden/Shadow commons converted; Rainbow common + special Uncommon kept');

  // OFF (default) → the old behavior: all special-variant commons protected
  const off = pickRecycleFodder(roster, { recycleFodderRarities: ['common'] }).map(c => c.id);
  assert.equal(off.length, 0, 'without the flag, special-variant commons stay protected');
});

test('lux: pickBreedingIntake берёт lux-коммона в ясли первым', () => {
  const luxCommon = { id: 'lx', creature_id: 'glimra', rarity: 'Common', stage: 'Baby', breed_count: 0 };
  const unc = { id: 'u1', rarity: 'Uncommon', stage: 'Baby', breed_count: 0 };
  const got = pickBreedingIntake([unc, luxCommon], { vaultBreedingRarities: ['uncommon'] }, {});
  assert.equal(got?.id, 'lx', 'lux вне rarity-фильтра и с приоритетом');
});

test('lux: planBreedPair бридит пару lux-коммонов первой (снизу-вверх по рарности)', () => {
  const cfg = { breedMinRarity: 'uncommon' };
  const roster = [
    base({ id: 'g1', creature_id: 'glimra', rarity: 'Common' }),
    base({ id: 'g2', creature_id: 'glimra', rarity: 'Common' }),
    base({ id: 'u1', creature_id: 'brambark', rarity: 'Uncommon' }),
    base({ id: 'u2', creature_id: 'brambark', rarity: 'Uncommon' }),
  ];
  const plan = planBreedPair(roster, cfg, NOW);
  assert.equal(plan.species, 'glimra', 'common (lux) ниже uncommon → первым');
});

// ── 2026-07-06 ночь: «почему рарки/епики не бридятся» — epic thornmaw-пары существовали у 5 акков,
// но 0 epic-бридов за ночь. Причины: (1) intake брал НАИМЕНЕЕ ценного (= вечно uncommon), epic
// никогда не доходил до яслей и постоянно улетал в данжи; (2) vaultSwap выдёргивал бы бридера из
// сейфа обратно в данжи (стронг stored > слабейший активный). Фиксы: intake сортирует lux → есть-пара
// → рарность DESC; vaultSwap не трогает брид-сток (breed_count<8, рарность из vaultBreedingRarities).
import { planVaultSwap } from '../src/marketplace.js';

test('intake: epic с same-species парой приоритетнее одиночного uncommon', () => {
  const roster = [
    { id: 'u1', creature_id: 'brambark', rarity: 'Uncommon', stage: 'Baby', breed_count: 0 },
    { id: 'e1', creature_id: 'thornmaw', rarity: 'Epic', stage: 'Adult', breed_count: 0 },
    { id: 'e2', creature_id: 'thornmaw', rarity: 'Epic', stage: 'Baby', breed_count: 0 },
  ];
  const cfg = { vaultBreedingRarities: ['uncommon', 'rare', 'epic'] };
  const got = pickBreedingIntake(roster, cfg, {});
  assert.equal(String(got?.creature_id), 'thornmaw', 'парный epic первым в ясли');
});

// 2026-07-06 (owner "увеличиваем vault до максимального"): with a huge vaultBreedingPoolTarget intake would
// otherwise drain EVERY rare/epic into the vault (it sorts rarity DESC) and gut the dungeon runners. Reserve
// the top-N Rare+ as runners — the same core the pressure valve keeps — and vault only the surplus.
test('intake: reserves the top-N Rare+ as dungeon runners (vaultKeepStrongestRareplus), vaults the surplus', () => {
  const roster = [
    { id: 'ep1', creature_id: 'thornmaw', rarity: 'Epic', stage: 'Adult', level: 30, breed_count: 0 }, // strongest → runner
    { id: 'ep2', creature_id: 'thornmaw', rarity: 'Epic', stage: 'Baby', level: 1, breed_count: 0 },   // weaker epic → surplus
    { id: 'u1', creature_id: 'brambark', rarity: 'Uncommon', stage: 'Baby', breed_count: 0 },
  ];
  const cfg = { vaultBreedingRarities: ['uncommon', 'rare', 'epic'], vaultKeepStrongestRareplus: 1 };
  const got = pickBreedingIntake(roster, cfg, {});
  assert.notEqual(got?.id, 'ep1', 'the strongest Epic stays an active runner, not vaulted');
  assert.ok(['ep2', 'u1'].includes(got?.id), 'a surplus Rare+ / uncommon is vaulted instead');

  // with the reserve OFF (default 0) the strongest epic IS the top intake pick (old behavior preserved)
  const off = pickBreedingIntake(roster, { vaultBreedingRarities: ['uncommon', 'rare', 'epic'] }, {});
  assert.equal(off?.creature_id, 'thornmaw', 'no reserve → epic pair still first');
});

test('vaultSwap: не выдёргивает из сейфа живой брид-сток (breed_count<8)', () => {
  const strongStored = { id: 's1', rarity: 'Epic', stage: 'Adult', level: 9, breed_count: 2, stored: true };
  const weakActive = { id: 'a1', rarity: 'Rare', stage: 'Baby', level: 1, breed_count: 0 };
  const cfg = { vaultBreedingRarities: ['uncommon', 'rare', 'epic'], vaultSwapMinValueMargin: 0 };
  assert.equal(planVaultSwap([strongStored, weakActive], cfg, {}), null, 'бридер остаётся в яслях');
  const exhaustedStored = { ...strongStored, breed_count: 8 };
  const plan = planVaultSwap([exhaustedStored, weakActive], cfg, {});
  assert.ok(plan, 'выдохшийся 8/8 — снова кандидат на swap');
});

// ── UNVAULT-клапан 2026-07-06 (live: сервер запрещает evolve в сейфе — «Withdraw this creature from
// storage before evolving it» ×24-69/акк): готовый по XP вейвленный малыш вынимается и эволюционирует
// в том же проходе; сырой (XP < порога стадии) остаётся в сейфе; лимит слотов ростера соблюдается.
test('handleEvolve: вынимает из сейфа готового по XP, эволюционирует; сырого не трогает', async () => {
  const bot = mkBot({ autoEvolve: true, depthObjective: 'gold-per-run', minGoldReserve: 0 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  const state = {
    player: { gold: 100000 },
    creatures: Array.from({ length: 10 }, (_, i) => ({ id: 'act' + i, stage: 'Elder' })), // ростер не полон
    stored: { creatures: [
      { id: 'ready', stage: 'Baby', creature_xp: 500, stored: true },
      { id: 'raw', stage: 'Baby', creature_xp: 40, stored: true },   // < 100 XP — не вынимаем
    ] },
    eggs: [],
  };
  await bot.handleEvolve(state);
  const moves = calls.filter(c => c.path === '/api/storage/move');
  assert.deepEqual(moves.map(m => m.body.itemId), ['ready'], 'вынут только готовый');
  assert.equal(moves[0].body.store, false);
  assert.ok(calls.some(c => c.path === '/api/creature/evolve' && c.body.creatureId === 'ready'), 'эволюция сразу после выемки');
  assert.ok(!calls.some(c => c.path === '/api/creature/evolve' && c.body.creatureId === 'raw'), 'сырой не эволюционируется');
});

test('handleEvolve: при почти полном ростере из сейфа не вынимает (слоты данжевого состава)', async () => {
  const bot = mkBot({ autoEvolve: true, depthObjective: 'gold-per-run', minGoldReserve: 0, vaultRosterFull: 10 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  const state = {
    player: { gold: 100000 },
    creatures: Array.from({ length: 9 }, (_, i) => ({ id: 'act' + i, stage: 'Elder' })), // 9 >= 10-1
    stored: { creatures: [{ id: 'ready', stage: 'Baby', creature_xp: 500, stored: true }] },
    eggs: [],
  };
  await bot.handleEvolve(state);
  assert.equal(calls.filter(c => c.path === '/api/storage/move').length, 0, 'ростер на грани — не вынимаем');
});

// ── АНТИ-ПЕТЛЯ vault↔unvault 2026-07-06 (live: 148 петов до 11 циклов/2ч): Juvenile-порог был 250
// при серверных 13 покормках × 20 = 260 XP — пет с 250-259 вечно вынимался и отклонялся; плюс
// отклонённый эволюцией пет не вынимается повторно час; listed не лезет в очередь эволюции.
test('handleEvolve: Juvenile с 255 XP НЕ вынимается (порог 260), с 260 — вынимается', async () => {
  const mk = (xp) => ({
    player: { gold: 100000 },
    creatures: Array.from({ length: 5 }, (_, i) => ({ id: 'act' + i, stage: 'Elder' })),
    stored: { creatures: [{ id: 'juv', stage: 'Juvenile', creature_xp: xp, stored: true }] },
    eggs: [],
  });
  const bot = mkBot({ autoEvolve: true, depthObjective: 'gold-per-run', minGoldReserve: 0 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  await bot.handleEvolve(mk(255));
  assert.equal(calls.filter(c => c.path === '/api/storage/move').length, 0, '255 < 260 — сырой');
  bot.nextEvolveAt = 0;
  await bot.handleEvolve(mk(260));
  assert.equal(calls.filter(c => c.path === '/api/storage/move').length, 1, '260 — готов');
});

test('handleEvolve: пет с отклонённой эволюцией не вынимается повторно (память отказов)', async () => {
  const bot = mkBot({ autoEvolve: true, depthObjective: 'gold-per-run', minGoldReserve: 0 });
  const calls = [];
  bot.act = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/creature/evolve') { const e = new Error('no'); e.status = 402; e.bodyText = '{"error":"Not enough Gold"}'; throw e; }
    return {};
  };
  const state = {
    player: { gold: 100000 },
    creatures: Array.from({ length: 5 }, (_, i) => ({ id: 'act' + i, stage: 'Elder' })),
    stored: { creatures: [{ id: 'loop', stage: 'Baby', creature_xp: 500, stored: true }] },
    eggs: [],
  };
  await bot.handleEvolve(state);
  assert.equal(calls.filter(c => c.path === '/api/storage/move').length, 1, 'первый раз вынули');
  bot.nextEvolveAt = 0;
  state.stored.creatures[0].stored = true; // intake запарковал обратно
  await bot.handleEvolve(state);
  assert.equal(calls.filter(c => c.path === '/api/storage/move').length, 1, 'повторной выемки НЕТ — отказник в памяти');
});

test('handleEvolve: listed-пет не попадает в очередь эволюции', async () => {
  const bot = mkBot({ autoEvolve: true, depthObjective: 'gold-per-run', minGoldReserve: 0 });
  const calls = [];
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  await bot.handleEvolve({
    player: { gold: 100000 },
    creatures: [{ id: 'lst', stage: 'Baby', creature_xp: 500, listed: true }],
    eggs: [],
  });
  assert.equal(calls.filter(c => c.path === '/api/creature/evolve').length, 0, 'listed скипнут');
});
