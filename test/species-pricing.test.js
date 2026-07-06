import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marketSpeciesOf,
  marketTraitsOf,
  parseSales,
  creatureMetricsBySpecies,
  creatureAsksBySpecies,
  creatureIdealPriceUsd,
} from '../src/marketplace.js';

test('marketTraitsOf extracts rarity/variant/species for the sales log (nested or flat, null when absent)', () => {
  assert.deepEqual(marketTraitsOf({ item: { species: 'Smoldra', rarity: 'Uncommon', variant: 'Rainbow' } }),
    { rarity: 'uncommon', variant: 'rainbow', species: 'smoldra' });
  assert.deepEqual(marketTraitsOf({ species: 'Quartz', rarity: 'Rare' }),
    { rarity: 'rare', variant: null, species: 'quartz' });
  assert.deepEqual(marketTraitsOf({ item_kind: 'gold', quantity: 50000 }),
    { rarity: null, variant: null, species: null }, 'fungible gold → all null (renders as —)');
});

// 2026-07-06: per-species market metrics + species-first "ideal price" waterfall.

test('marketSpeciesOf extracts species from every plausible field shape', () => {
  assert.equal(marketSpeciesOf({ species: 'Smoldra' }), 'smoldra');
  assert.equal(marketSpeciesOf({ item: { species: 'Quartz' } }), 'quartz'); // nested under item — the likely live shape
  assert.equal(marketSpeciesOf({ creature_id: 'Florix' }), 'florix');
  assert.equal(marketSpeciesOf({ item: { name: 'Thornmaw' } }), 'thornmaw');
  assert.equal(marketSpeciesOf({}), '', 'no species field → empty (falls back to rarity pricing)');
});

test('parseSales populates species (defensively)', () => {
  const rows = parseSales({ sales: [
    { item_kind: 'creature', price_usd: 0.1, rarity: 'Uncommon', item: { species: 'Smoldra' } },
    { item_kind: 'creature', price_usd: 0.2, rarity: 'Uncommon', species: 'Quartz' },
  ] });
  assert.deepEqual(rows.map(r => r.species), ['smoldra', 'quartz']);
});

test('creatureMetricsBySpecies: floor=min, clearing=median, count; excludes fleet/gems/special variants', () => {
  const sales = parseSales({ sales: [
    { item_kind: 'creature', price_usd: 0.10, currency: 'zenko', rarity: 'Uncommon', variant: 'Normal', species: 'smoldra' },
    { item_kind: 'creature', price_usd: 0.14, currency: 'zenko', rarity: 'Uncommon', variant: 'Normal', species: 'smoldra' },
    { item_kind: 'creature', price_usd: 0.12, currency: 'zenko', rarity: 'Uncommon', variant: 'Normal', species: 'smoldra' },
    { item_kind: 'creature', price_usd: 0.99, currency: 'zenko', rarity: 'Uncommon', variant: 'Golden', species: 'smoldra' }, // special variant → excluded
    { item_kind: 'creature', price_usd: 0.01, currency: 'zenko', rarity: 'Uncommon', variant: 'Normal', species: 'smoldra', seller: 'FLEET1' }, // our own → excluded
    { item_kind: 'creature', price_usd: 5.0, currency: 'gems', rarity: 'Uncommon', variant: 'Normal', species: 'smoldra' }, // gems lane → excluded
    { item_kind: 'creature', price_usd: 0.20, currency: 'zenko', rarity: 'Uncommon', variant: 'Normal', species: 'quartz' },
  ] });
  const m = creatureMetricsBySpecies(sales, { fleetWallets: ['FLEET1'] });
  assert.equal(m.smoldra.count, 3, 'only the 3 clean normal external sales');
  assert.equal(m.smoldra.floorUsd, 0.10);
  assert.equal(m.smoldra.clearingUsd, 0.12, 'median of [0.10,0.12,0.14]');
  assert.equal(m.smoldra.rarity, 'uncommon');
  assert.equal(m.quartz.count, 1);
  assert.equal(m.quartz.clearingUsd, 0.20);
});

test('creatureAsksBySpecies: min external/fleet ask per species', () => {
  const rows = [
    { itemKind: 'creature', currency: 'zenko', priceUsd: 0.15, variant: 'normal', species: 'smoldra', seller: 'EXT1' },
    { itemKind: 'creature', currency: 'zenko', priceUsd: 0.11, variant: 'normal', species: 'smoldra', seller: 'EXT2' },
    { itemKind: 'creature', currency: 'zenko', priceUsd: 0.09, variant: 'normal', species: 'smoldra', seller: 'FLEET1' }, // our own
  ];
  const a = creatureAsksBySpecies(rows, { fleetWallets: ['FLEET1'] });
  assert.equal(a.smoldra.external, 0.11, 'cheapest external ask');
  assert.equal(a.smoldra.fleet, 0.09, 'our own cheapest ask (never undercut it)');
});

const CFG = { cashoutPriceJitterPct: 0, cashoutAskUndercutPct: 0.05, cashoutMinPriceUsd: 0.01, cashoutSpeciesMinSamples: 2 };
const price = (args) => creatureIdealPriceUsd({ cfg: CFG, rng: () => 0.5, ...args });

test('ideal price: species clearing wins when the species has ≥ minSamples sales', () => {
  const r = price({
    species: 'smoldra', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: { smoldra: { rarity: 'uncommon', floorUsd: 0.10, clearingUsd: 0.12, count: 3 } },
    clearingUsdByRarity: { uncommon: 0.08 }, // rarity signal exists but species is more specific → ignored
  });
  assert.equal(r.source, 'species-clearing');
  assert.equal(r.priceUsd, 0.12);
});

test('ideal price: species with < minSamples sales uses its own floor, not the weak median', () => {
  const r = price({
    species: 'quartz', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: { quartz: { rarity: 'uncommon', floorUsd: 0.20, clearingUsd: 0.20, count: 1 } },
  });
  assert.equal(r.source, 'species-floor');
  assert.equal(r.priceUsd, 0.20);
});

test('ideal price: falls back to rarity clearing when the species never traded', () => {
  const r = price({
    species: 'neverseen', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: {}, clearingUsdByRarity: { uncommon: 0.08 },
  });
  assert.equal(r.source, 'rarity-clearing');
  assert.equal(r.priceUsd, 0.08);
});

test('ideal price: seed floor is the last resort', () => {
  const r = price({
    species: 'neverseen', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: {}, clearingUsdByRarity: {}, asksByRarity: {},
    floorZolanaByRarity: {}, zolanaPriceUsd: null, // no live floor → uncommon seed 0.03
  });
  assert.equal(r.source, 'seed');
  assert.equal(r.priceUsd, 0.03);
});

test('ideal price: explicit (rarity,variant) override wins over all market signals', () => {
  const r = price({
    species: 'brambark', rarity: 'uncommon', variant: 'rainbow',
    metricsBySpecies: { brambark: { rarity: 'uncommon', floorUsd: 0.10, clearingUsd: 0.12, count: 5 } },
  });
  assert.equal(r.source, 'variant-override');
  assert.equal(r.priceUsd, 0.2); // CREATURE_VARIANT_PRICE_OVERRIDE_USD['uncommon:rainbow']
});

test('ideal price: never undercuts our own fleet ask (ladder against self-dump)', () => {
  const r = price({
    species: 'smoldra', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: { smoldra: { rarity: 'uncommon', floorUsd: 0.05, clearingUsd: 0.05, count: 3 } },
    asksBySpecies: { smoldra: { external: 0.04, fleet: 0.10 } }, // clearing 0.05 < our 0.10 fleet ask
  });
  assert.equal(r.priceUsd, 0.10, 'raised up to our own fleet ask, not below it');
});

test('ideal price: returns null when there is no usable signal at all', () => {
  const r = price({
    species: 'ghost', rarity: 'epic', variant: 'normal', // epic has no seed floor
    metricsBySpecies: {}, clearingUsdByRarity: {}, asksByRarity: {}, floorZolanaByRarity: {}, zolanaPriceUsd: null,
  });
  assert.equal(r, null);
});
