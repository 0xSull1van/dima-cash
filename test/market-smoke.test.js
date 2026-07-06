import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarketSmokePlan,
  parseMarketSmokeArgs,
  runMarketSmoke,
} from '../scripts/market-smoke.js';

test('parseMarketSmokeArgs requires an explicit account name', () => {
  assert.throws(
    () => parseMarketSmokeArgs([]),
    /Usage: node scripts\/market-smoke\.js <Account>/,
  );

  assert.equal(parseMarketSmokeArgs(['Zephyr']).accountName, 'Zephyr');
  assert.equal(parseMarketSmokeArgs(['--account=Zephyr']).accountName, 'Zephyr');
});

test('parseMarketSmokeArgs keeps dry-run read-only by default', () => {
  const args = parseMarketSmokeArgs(['Zephyr']);
  assert.equal(args.mode, 'read');
  assert.equal(args.execute, false);
  assert.equal(args.liveWrite, false);
});

test('parseMarketSmokeArgs requires strict live write flags', () => {
  assert.equal(parseMarketSmokeArgs(['Zephyr', 'list-cancel']).liveWrite, false);
  assert.equal(parseMarketSmokeArgs(['Zephyr', '--execute']).liveWrite, false);
  assert.equal(parseMarketSmokeArgs(['Zephyr', 'list-cancel', '--execute']).liveWrite, true);
  assert.throws(() => parseMarketSmokeArgs(['Zephyr', 'buy']), /unknown mode/i);
});

test('buildMarketSmokePlan plans a small guarded Gold listing only in live mode', () => {
  const dry = buildMarketSmokePlan({
    args: parseMarketSmokeArgs(['Zephyr']),
    gold: 500_000,
    floorUsd: 0.000002,
    rng: () => 0,
  });
  assert.equal(dry.action, 'read-only');
  assert.equal(dry.listing, null);

  const live = buildMarketSmokePlan({
    args: parseMarketSmokeArgs(['Zephyr', 'list-cancel', '--execute']),
    gold: 500_000,
    floorUsd: 0.000002,
    rng: () => 0,
  });
  assert.equal(live.action, 'list-cancel');
  assert.equal(live.listing.itemKind, 'gold');
  assert.equal(live.listing.currency, 'zenko');
  assert.ok(live.listing.quantity >= 50_000);
  assert.ok(live.listing.priceUsd >= 0.05);
});

test('buildMarketSmokePlan can smoke-test low but sufficient Gold balances', () => {
  const live = buildMarketSmokePlan({
    args: parseMarketSmokeArgs(['main', 'list-cancel', '--execute']),
    gold: 86_970,
    floorUsd: 0.000001,
    rng: () => 0,
  });

  assert.equal(live.action, 'list-cancel');
  assert.ok(live.listing.quantity >= 50_000);
  assert.ok(live.listing.quantity <= 86_970);
});

test('runMarketSmoke reads player state and market summaries without writes by default', async () => {
  const calls = [];
  const deps = {
    rng: () => 0,
    readPlayerState: async () => {
      calls.push('readPlayerState');
      return { player: { gold: 500_000, gems: 7, level: 4, stamina: 120, zenko_balance: 42 } };
    },
    getGoldFloorUsd: async () => {
      calls.push('getGoldFloorUsd');
      return 0.000002;
    },
    getMyListings: async () => {
      calls.push('getMyListings');
      return [{ id: 'own-1', itemKind: 'gold', currency: 'zenko', status: 'active' }];
    },
    getMySales: async () => {
      calls.push('getMySales');
      return [{ id: 'sale-1', item_kind: 'gold', quantity: 1000, price_usd: 0.01 }];
    },
    listGold: async () => {
      calls.push('listGold');
      throw new Error('must not write');
    },
    cancelListing: async () => {
      calls.push('cancelListing');
      throw new Error('must not write');
    },
  };

  const summary = await runMarketSmoke(parseMarketSmokeArgs(['Zephyr']), deps);

  assert.deepEqual(calls, ['readPlayerState', 'getGoldFloorUsd', 'getMyListings', 'getMySales']);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.writeAttempted, false);
  assert.equal(summary.player.gold, 500_000);
  assert.equal(summary.market.ownListings.count, 1);
  assert.equal(summary.market.recentSales.count, 1);
});

test('runMarketSmoke live mode lists and immediately cancels by returned listing id', async () => {
  const calls = [];
  const deps = {
    rng: () => 0,
    readPlayerState: async () => {
      calls.push(['readPlayerState']);
      return { player: { gold: 500_000 } };
    },
    getGoldFloorUsd: async () => {
      calls.push(['getGoldFloorUsd']);
      return 0.000002;
    },
    getMyListings: async () => {
      calls.push(['getMyListings']);
      return [];
    },
    getMySales: async () => {
      calls.push(['getMySales']);
      return [];
    },
    listGold: async (_client, listing) => {
      calls.push(['listGold', listing]);
      return { id: 'listing-123' };
    },
    cancelListing: async (_client, listingId) => {
      calls.push(['cancelListing', listingId]);
      return { ok: true };
    },
  };

  const summary = await runMarketSmoke(parseMarketSmokeArgs(['Zephyr', 'list-cancel', '--execute']), deps);

  assert.equal(calls[4][0], 'listGold');
  assert.equal(calls[5][0], 'cancelListing');
  assert.equal(calls[5][1], 'listing-123');
  assert.equal(summary.dryRun, false);
  assert.equal(summary.writeAttempted, true);
  assert.equal(summary.live.listingId, 'listing-123');
  assert.deepEqual(summary.live.cancelResult, { ok: true });
});

// РЕГРЕССИЯ 2026-07-06: floor существ считался по продажам ВСЕХ вариантов — Golden/Shiny-продажа
// за $0.5 задирала floor uncommon с $0.02 до $0.5 (свечи дашборда прыгали ×25, бот листил наших
// normal-петов по цене чужого golden). Floor и объём — только normal-вариант.
import { test as vtest } from 'node:test';
import vassert from 'node:assert/strict';
import { parseSales, creatureFloorZolanaByRarity, salesCountByRarity } from '../src/marketplace.js';

vtest('creature floor игнорирует особые варианты (Golden/Shiny/Rainbow), считает только normal', () => {
  const sales = parseSales({ sales: [
    { item_kind: 'creature', price_usd: 0.02, rarity: 'Uncommon', variant: 'Normal', seller: 'A' },
    { item_kind: 'creature', price_usd: 0.50, rarity: 'Uncommon', variant: 'Golden', seller: 'B' },
    { item_kind: 'creature', price_usd: 0.45, rarity: 'Uncommon', variant: 'Shiny', seller: 'C' },
  ] });
  const floors = creatureFloorZolanaByRarity(sales, { zolanaPriceUsd: 0.0002 });
  vassert.equal(floors.uncommon, 0.02 / 0.0002, 'floor = normal-продажа, golden не задирает');
  const counts = salesCountByRarity(sales, {});
  vassert.equal(counts.uncommon, 1, 'объём — те же продажи, что и цена');
  // окно из ОДНИХ особых вариантов → floor рарности отсутствует (не ложный $0.5)
  const onlySpecial = parseSales({ sales: [{ item_kind: 'creature', price_usd: 0.5, rarity: 'Uncommon', variant: 'Golden', seller: 'B' }] });
  vassert.equal(creatureFloorZolanaByRarity(onlySpecial, { zolanaPriceUsd: 0.0002 }).uncommon, undefined);
  // variant отсутствует в ответе сервера (старые записи) → считается normal, floor работает
  const noVariant = parseSales({ sales: [{ item_kind: 'creature', price_usd: 0.03, rarity: 'Rare', seller: 'D' }] });
  vassert.equal(creatureFloorZolanaByRarity(noVariant, { zolanaPriceUsd: 0.0002 }).rare, 150);
});

// Режим слива 2026-07-06 (owner: «меньше флора на 25-35%, хаотично, быстро сливать и беспалевно»):
// undercutMin/Max > 0 → цена строго НИЖЕ floor в окне [1-max..1-min], своя скидка на каждый лот.
import { planOrganicPrice, planListingReprice } from '../src/marketplace.js';

vtest('planOrganicPrice: undercut-режим даёт цену в окне floor×[0.65..0.75], хаотично', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = planOrganicPrice({ floorUsd: 1.00, undercutMin: 0.25, undercutMax: 0.35, minPriceUsd: 0.01 });
    vassert.ok(p.priceUsd >= 0.65 && p.priceUsd <= 0.75, `в окне (got ${p.priceUsd})`);
    seen.add(p.priceUsd);
  }
  vassert.ok(seen.size >= 5, `скидка случайная, не одна точка (distinct=${seen.size})`);
  // undercut выключен (0) → старое поведение: джиттер вокруг floor
  const j = planOrganicPrice({ floorUsd: 1.00, jitterPct: 0.03, undercutMin: 0, undercutMax: 0 });
  vassert.ok(j.priceUsd >= 0.97 && j.priceUsd <= 1.03, 'без undercut — кластер вокруг floor');
  // minPriceUsd всё ещё пол: floor $0.02 × 0.65 = $0.013 → округление по центам, но не ниже 0.01
  const low = planOrganicPrice({ floorUsd: 0.02, undercutMin: 0.25, undercutMax: 0.35, minPriceUsd: 0.01 });
  vassert.ok(low.priceUsd >= 0.01, 'не ниже minPriceUsd');
});

vtest('planListingReprice: в undercut-режиме существо репрайсится в середину скидочного окна, не в floor', () => {
  const listing = { id: 'L1', item_kind: 'creature', item_id: 'c1', status: 'active', currency: 'zenko', price_usd: 1.00, created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() };
  const cfg = { cashoutRepriceMinAgeMs: 60 * 60 * 1000, cashoutRepriceMinDropPct: 0.05, cashoutMinPriceUsd: 0.01, cashoutUndercutPctMin: 0.25, cashoutUndercutPctMax: 0.35 };
  const plan = planListingReprice({ listing, floorUsd: 1.00, cfg });
  vassert.ok(plan, 'план есть — лот висит выше скидочной зоны');
  vassert.equal(plan.newPriceUsd, 0.70, 'floor × (1 − 0.30 midpoint)');
});

// ── 2026-07-06: «не 1 продажи за ночь» — sellable-сток был 1 пет на флот: гейт junkMinBreedCount=8
// пропускал только выдохшихся, а брид только разогнался. junkSurplusKeepPerSpecies=N: излишек сверх
// топ-N одного (вид,рарность) продаётся СРАЗУ, не дожидаясь 8/8 — брид-сток (2 пары) остаётся.
import { pickJunkCreatures } from '../src/marketplace.js';

vtest('pickJunkCreatures: излишек сверх keep-N продаётся до исчерпания бридов', () => {
  const mk = (id, lvl) => ({ id, creature_id: 'brambark', species: 'brambark', rarity: 'Uncommon', stage: 'Adult', variant: 'Normal', breed_count: 0, level: lvl });
  const roster = [mk('p1', 9), mk('p2', 8), mk('p3', 7), mk('p4', 6), mk('p5', 2), mk('p6', 1)];
  const cfg = { junkCreatureRarities: ['uncommon'], junkCreatureStages: ['Adult'], junkMinBreedCount: 8, junkSurplusKeepPerSpecies: 4, junkCreatureKeepPerSpecies: 0 };
  const out = pickJunkCreatures(roster, cfg);
  assert.deepEqual(out.map(c => c.id).sort(), ['p5', 'p6'], 'слабейшие сверх топ-4 — на продажу');
  // без кнопки — старое поведение (только 8/8)
  const none = pickJunkCreatures(roster, { ...cfg, junkSurplusKeepPerSpecies: null });
  assert.equal(none.length, 0);
});

// ── DEMAND-модель 2026-07-06 (owner: «цены по которым берут, не дампили друг друга»)
import { creatureClearingUsdByRarity, creatureAsksByRarity, planDemandPrice } from '../src/marketplace.js';

vtest('creatureClearingUsdByRarity: медиана внешних normal-продаж, свои/особые исключены', () => {
  const sales = parseSales({ sales: [
    { item_kind: 'creature', price_usd: 0.02, rarity: 'Uncommon', variant: 'Normal', seller: 'A' },
    { item_kind: 'creature', price_usd: 0.05, rarity: 'Uncommon', variant: 'Normal', seller: 'B' },
    { item_kind: 'creature', price_usd: 0.30, rarity: 'Uncommon', variant: 'Normal', seller: 'C' },
    { item_kind: 'creature', price_usd: 9.99, rarity: 'Uncommon', variant: 'Golden', seller: 'D' },  // особый — мимо
    { item_kind: 'creature', price_usd: 0.01, rarity: 'Uncommon', variant: 'Normal', seller: 'OUR' }, // свой — мимо
  ] });
  const c = creatureClearingUsdByRarity(sales, { fleetWallets: ['OUR'] });
  vassert.equal(c.uncommon, 0.05, 'медиана [0.02,0.05,0.30] = 0.05 — не min и не выброс');
});

vtest('planDemandPrice: clearing → ask-фолбэк → null; лесенка не подрезает свой флот', () => {
  const rng = () => 0.5; // джиттер = 0
  vassert.equal(planDemandPrice({ clearingUsd: 0.05, rng }).priceUsd, 0.05, 'база = по чём берут');
  vassert.equal(planDemandPrice({ lowestAskUsd: 0.10, askUndercutPct: 0.05, rng }).priceUsd, 0.09, 'нет продаж → под чужой аск (floor-к-центу сохраняет подрез)');
  vassert.equal(planDemandPrice({}, ), null, 'нет сигналов → null (caller уходит в seed)');
  const laddered = planDemandPrice({ clearingUsd: 0.03, fleetAskUsd: 0.06, rng });
  vassert.equal(laddered.priceUsd, 0.06, 'наш активный лот по 0.06 → не встаём под него по 0.03');
});

vtest('creatureAsksByRarity: делит мин-аски на внешние и флотские', () => {
  const rows = [
    { itemKind: 'creature', currency: 'zenko', priceUsd: 0.08, rarity: 'uncommon', variant: 'normal', seller: 'EXT1' },
    { itemKind: 'creature', currency: 'zenko', priceUsd: 0.04, rarity: 'uncommon', variant: 'normal', seller: 'OUR' },
    { itemKind: 'creature', currency: 'zenko', priceUsd: 0.50, rarity: 'uncommon', variant: 'golden', seller: 'EXT2' }, // особый — мимо
  ];
  const a = creatureAsksByRarity(rows, { fleetWallets: ['OUR'] });
  vassert.equal(a.uncommon.external, 0.08);
  vassert.equal(a.uncommon.fleet, 0.04);
});

vtest('planListingReprice: decay-режим опускает от ТЕКУЩЕЙ цены, не прыгает во floor', () => {
  const listing = { id: 'L1', item_kind: 'creature', item_id: 'c1', status: 'active', currency: 'zenko', price_usd: 0.10, created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() };
  const cfg = { cashoutRepriceMinAgeMs: 3600e3, cashoutRepriceMinDropPct: 0.05, cashoutMinPriceUsd: 0.01, cashoutRepriceDecayPct: 0.12 };
  const plan = planListingReprice({ listing, floorUsd: 0.02, cfg });
  vassert.ok(plan, 'лот старше часа — план есть');
  vassert.equal(plan.newPriceUsd, Math.ceil(0.10*0.88*100)/100, '0.10 → ×0.88, а не floor 0.02');
});

// 2026-07-06 (owner: «маркет сливает петтов в пол»): decay больше НЕ опускает ниже rarity-флора спроса —
// раньше катилось до minPriceUsd $0.01, дампя Uncommon сильно ниже реальной цены рынка (45% листингов ≤$0.03).
vtest('planListingReprice: decay клэмпится на rarity-флор, не сливает в $0.01', () => {
  const listing = { id: 'L1', item_kind: 'creature', item_id: 'c1', status: 'active', currency: 'zenko', price_usd: 0.18, created_at: new Date(Date.now() - 2 * 3600e3).toISOString() };
  const cfg = { cashoutRepriceMinAgeMs: 3600e3, cashoutRepriceMinDropPct: 0.05, cashoutMinPriceUsd: 0.01, cashoutRepriceDecayPct: 0.12 };
  // decay хочет 0.18×0.88=0.158, но rarity-флор 0.16 → клэмп в 0.16 (не ниже уровня спроса)
  const plan = planListingReprice({ listing, floorUsd: 0.16, cfg });
  vassert.ok(plan, 'с 0.18 ещё можно опустить до флора 0.16');
  vassert.equal(plan.newPriceUsd, 0.16, 'клэмп на rarity-флор $0.16, а не $0.158 и точно не $0.01');
});

vtest('planListingReprice: на rarity-флоре больше НЕ репрайсит (держит уровень спроса)', () => {
  const listing = { id: 'L1', item_kind: 'creature', item_id: 'c1', status: 'active', currency: 'zenko', price_usd: 0.16, created_at: new Date(Date.now() - 5 * 3600e3).toISOString() };
  const cfg = { cashoutRepriceMinAgeMs: 3600e3, cashoutRepriceMinDropPct: 0.05, cashoutMinPriceUsd: 0.01, cashoutRepriceDecayPct: 0.12 };
  // уже на флоре: decay хочет 0.14, клэмп = 0.16 = текущая → newPrice не ниже current → null (стоп)
  const plan = planListingReprice({ listing, floorUsd: 0.16, cfg });
  vassert.equal(plan, null, 'на демо-флоре стоп — ниже не сливаем');
});

// ── Адаптивный темп 2026-07-06 (owner: «хаотично, как надо для темпа рынка, по последним продажам
// и времени продаж»): скорость поглощения рынка → наш кулдаун листинга.
import { salesVelocityPerHour, planListingPace } from '../src/marketplace.js';

vtest('salesVelocityPerHour: считает внешние normal-продажи за покрытое окно', () => {
  const now = Date.parse('2026-07-06T12:00:00Z');
  const mk = (hAgo, over = {}) => ({ item_kind: 'creature', price_usd: 0.05, rarity: 'Uncommon', variant: 'Normal', seller: 'EXT', sold_at: new Date(now - hAgo * 3600e3).toISOString(), ...over });
  const sales = parseSales({ sales: [mk(0.5), mk(1), mk(1.5), mk(2), mk(1.2, { seller: 'OUR' }), mk(1.1, { variant: 'Golden' })] });
  const v = salesVelocityPerHour(sales, { fleetWallets: ['OUR'], now });
  vassert.equal(v.sampled, 4, 'свои и особые не в счёт');
  vassert.ok(v.perHour > 1.5 && v.perHour < 2.5, `~2/час (got ${v.perHour.toFixed(2)})`);
  vassert.equal(salesVelocityPerHour(parseSales({ sales: [] }), { now }).perHour, 0, 'пусто → 0');
});

vtest('planListingPace: горячий рынок → короткий кулдаун, мёртвый → потолок, хаос в границах', () => {
  const fix = (r) => () => r;
  // 10 продаж/час, 18 sellers, доля 40% → база 18/(10×0.4)=4.5ч → кламп в потолок 4ч
  vassert.equal(planListingPace({ perHour: 10, sellers: 18, sharePct: 0.4, minMs: 480e3, maxMs: 4 * 3600e3, rng: fix(0.5) }), 4 * 3600e3);
  // 100 продаж/час → база 27м, джиттер 0.6..1.4 → 16..38м
  const hot = planListingPace({ perHour: 100, sellers: 18, sharePct: 0.4, minMs: 480e3, maxMs: 4 * 3600e3, rng: fix(0) });
  vassert.ok(hot >= 480e3 && hot < 30 * 60e3, `горячий рынок → минуты (got ${Math.round(hot / 60e3)}м)`);
  // нет данных → maxMs с джиттером вниз, не бесконечность и не 0
  const dead = planListingPace({ perHour: 0, minMs: 480e3, maxMs: 3600e3, rng: fix(0.5) });
  vassert.equal(dead, 3600e3);
});
