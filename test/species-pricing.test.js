import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marketSpeciesOf,
  marketTraitsOf,
  parseSales,
  creatureMetricsBySpecies,
  creatureAsksBySpecies,
  creatureIdealPriceUsd,
  creatureVariantFloorUsd,
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

test('ideal price: falls back to rarity clearing when the species never traded (≥ minSamples sales)', () => {
  const r = price({
    species: 'neverseen', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: {}, clearingUsdByRarity: { uncommon: 0.08 }, clearingCountByRarity: { uncommon: 3 },
  });
  assert.equal(r.source, 'rarity-clearing');
  assert.equal(r.priceUsd, 0.08);
});

// 2026-07-06 (owner "почему так дорого листим" — Vortex listed an Uncommon at $1.67 on a $0.05 floor): the
// rarity median had NO minSamples guard, so a single outlier external sale set the price. Now it needs
// ≥ minSamples sales or it's dropped in favour of the floor/seed.
test('ideal price: rarity clearing from < minSamples sales is IGNORED (thin-data guard) → seed', () => {
  const r = price({
    species: 'neverseen', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: {},
    clearingUsdByRarity: { uncommon: 1.75 }, // one $1.75 outlier sale …
    clearingCountByRarity: { uncommon: 1 },   // … only 1 sample → not trusted
    floorZolanaByRarity: {}, zolanaPriceUsd: null, // no live floor → uncommon seed 0.03
  });
  assert.equal(r.source, 'seed', 'the lone-sale median is dropped; price falls to the seed');
  assert.equal(r.priceUsd, 0.03, 'sane seed price, not $1.67');
});

test('ideal price: sanity cap blocks an absurd clearing even with enough samples (floor × cashoutMaxPriceOverFloor)', () => {
  const r = price({
    species: 'neverseen', rarity: 'uncommon', variant: 'normal',
    metricsBySpecies: {},
    clearingUsdByRarity: { uncommon: 1.75 }, clearingCountByRarity: { uncommon: 4 }, // trusted, but absurd
    floorZolanaByRarity: { uncommon: 250 }, zolanaPriceUsd: 0.0002, // live floor 250 × 0.0002 = $0.05
  });
  assert.equal(r.source, 'rarity-clearing');
  assert.equal(r.priceUsd, 0.5, 'capped at floor $0.05 × 10, not $1.66');
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

// 2026-07-07 (owner: "рарные uncommon — каждый трейт отдельно, флор по последнему, по чуть завышеной"):
// a special variant prices off ITS OWN live per-trait floor × premium, above the plain rarity price.
test('creatureVariantFloorUsd: per-trait min from real special-variant sales (normal + fleet excluded)', () => {
  const sales = parseSales({ sales: [
    { item_kind: 'creature', price_usd: 0.12, rarity: 'Uncommon', variant: 'Shadow', seller: 'A' },
    { item_kind: 'creature', price_usd: 0.09, rarity: 'Uncommon', variant: 'Shadow', seller: 'B' }, // min shadow
    { item_kind: 'creature', price_usd: 0.30, rarity: 'Uncommon', variant: 'Golden', seller: 'C' },
    { item_kind: 'creature', price_usd: 0.05, rarity: 'Uncommon', variant: 'Normal', seller: 'D' }, // normal → not here
    { item_kind: 'creature', price_usd: 0.01, rarity: 'Uncommon', variant: 'Shadow', seller: 'OUR' }, // fleet → excluded
  ] });
  const vf = creatureVariantFloorUsd(sales, { fleetWallets: ['OUR'] });
  assert.equal(vf['uncommon:shadow'], 0.09, 'min external Shadow sale');
  assert.equal(vf['uncommon:golden'], 0.30);
  assert.equal(vf['uncommon:normal'], undefined, 'normal is the per-rarity floor, not a per-trait one');
});

test('ideal price: special variant priced on its OWN trait floor × premium (not the plain rarity)', () => {
  const r = creatureIdealPriceUsd({
    cfg: { ...CFG, cashoutVariantPremiumPct: 0.1 }, rng: () => 0.5,
    species: 'smoldra', rarity: 'uncommon', variant: 'shadow',
    variantFloorUsd: { 'uncommon:shadow': 0.10 },
    clearingUsdByRarity: { uncommon: 0.05 }, clearingCountByRarity: { uncommon: 5 }, // cheaper plain rarity — ignored
  });
  assert.equal(r.source, 'variant-floor');
  assert.equal(r.priceUsd, 0.11, 'trait floor 0.10 × (1 + 0.1 premium)');
});

test('ideal price: special variant with no live trait floor → manual override, else base rarity price', () => {
  const withOverride = price({ species: 'x', rarity: 'uncommon', variant: 'golden', variantFloorUsd: {} });
  assert.equal(withOverride.source, 'variant-override');
  assert.equal(withOverride.priceUsd, 0.05); // seed golden

  const noSignal = price({ species: 'x', rarity: 'uncommon', variant: 'shiny', variantFloorUsd: {}, floorZolanaByRarity: {}, zolanaPriceUsd: null });
  assert.equal(noSignal.source, 'seed', 'no trait signal → still lists at the base rarity price, not skipped');
  assert.equal(noSignal.priceUsd, 0.03);
});

// 2026-07-07 (owner: "среднюю цену −5-7% от рыночной, учитывать все трейты"): Discord real-market median wins.
test('ideal price: Discord median − discount is the PRIMARY signal (step 0), uncapped', () => {
  const r = creatureIdealPriceUsd({
    cfg: { ...CFG, cashoutDiscordDiscountPct: 0.06, cashoutDiscordMinSamples: 1 }, rng: () => 0.5,
    species: 'stormray', rarity: 'rare', variant: 'normal',
    discordMedianUsd: { rare: 0.10 }, discordCounts: { rare: 13 },
    clearingUsdByRarity: { rare: 0.02 }, clearingCountByRarity: { rare: 9 }, // in-game thin data is cheaper — ignored
    floorZolanaByRarity: { rare: 100 }, zolanaPriceUsd: 0.0002,              // rarity floor $0.02 → cap $0.20, but Discord isn't capped
  });
  assert.equal(r.source, 'discord:rare');
  assert.equal(r.priceUsd, 0.09, 'median 0.10 × (1 − 0.06) = 0.094 → floor-to-cent 0.09 (was $0.04 before)');
});

test('ideal price: Discord picks the most specific trait (species:variant), min-samples respected', () => {
  const md = { 'epic:golden': 0.40, 'epic:golden:cyclonix': 0.42 };
  const cnt = { 'epic:golden': 3, 'epic:golden:cyclonix': 2 };
  const specific = creatureIdealPriceUsd({ cfg: { ...CFG, cashoutDiscordDiscountPct: 0, cashoutDiscordMinSamples: 1 }, rng: () => 0.5, species: 'cyclonix', rarity: 'epic', variant: 'golden', discordMedianUsd: md, discordCounts: cnt });
  assert.equal(specific.source, 'discord:epic:golden:cyclonix');
  assert.equal(specific.priceUsd, 0.42);
  // require ≥3 samples → the species key (n=2) is skipped, falls to the variant key (n=3)
  const broader = creatureIdealPriceUsd({ cfg: { ...CFG, cashoutDiscordDiscountPct: 0, cashoutDiscordMinSamples: 3 }, rng: () => 0.5, species: 'cyclonix', rarity: 'epic', variant: 'golden', discordMedianUsd: md, discordCounts: cnt });
  assert.equal(broader.source, 'discord:epic:golden');
});

test('ideal price: no Discord data → falls through to the existing in-game logic', () => {
  const r = price({ species: 'x', rarity: 'uncommon', variant: 'normal', discordMedianUsd: {}, floorZolanaByRarity: {}, zolanaPriceUsd: null });
  assert.equal(r.source, 'seed', 'empty Discord → seed as before');
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
