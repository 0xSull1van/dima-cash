// Tests for src/marketplace.js pure logic + write guard (no network).
import {
  parseListings, goldFloorUsd, marketFloorUsd, isDoneScaling, planGoldListing,
  planUniqueFloorListing, pickJunkRelics, pickJunkCreatures, newlySold, assertWriteAllowed,
  saleLedgerAmounts, activeListingCount, chooseCashoutLane, getMyListings, getMyGoldListings,
  planListingReprice, pickRecycleFodder, pickPlacedFodder, pickRecycleTarget, isSpecialVariant, isInRun,
  parseSales, creatureFloorZolanaByRarity, petFloorValueZolana, planOrganicPrice, pickVaultCandidate,
  isProtectedVariant, creatureFloorUsdForRarity, CREATURE_FLOOR_SEED_USD, planVaultSwap,
  pickBreedingIntake, pickBreedingGraduate, CREATURE_VARIANT_PRICE_OVERRIDE_USD, salesCountByRarity,
  getCreatureFloorAndVolumeByRarity,
} from '../src/marketplace.js';

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.log('  FAIL:', m));

// ── parseListings / goldFloorUsd ──
const sample = { listings: [
  { id: 'a', item_kind: 'gold', quantity: 411666, price_usd: 0.95, currency: 'zenko', created_at: '2026-07-04T08:00:00Z' },
  { id: 'b', item_kind: 'gold', quantity: 200000, price_usd: 0.36, currency: 'zenko' },
  { id: 'g', item_kind: 'gold', quantity: 100000, price_usd: 0.10, currency: 'gems' }, // gem lane ignored
  { id: 'c', item_kind: 'relic', quantity: 1, price_usd: 3.0, currency: 'zenko' },
]};
const rows = parseListings(sample);
ok(rows.length === 4, `parseListings count ${rows.length}`);
ok(rows[0].amount === 411666, 'maps quantity to amount');
ok(rows[0].listedAt === '2026-07-04T08:00:00Z', 'maps listing create timestamp');
// gold floor per-unit = min(0.95/411666, 0.36/200000) = min(0.0000023, 0.0000018) = 0.0000018
ok(Math.abs(goldFloorUsd(rows) - 0.0000018) < 1e-10, `goldFloorUsd ${goldFloorUsd(rows)}`);
ok(marketFloorUsd(rows, { itemKind: 'relic' }) === 3.0, `relic floor ${marketFloorUsd(rows, { itemKind: 'relic' })}`);
ok(goldFloorUsd(parseListings({ listings: [] })) === null, 'null floor when no gold');

// ── floor excludes our own fleet listings (anti self-dump / "по маркету" = внешний рынок) ──
const fleetSample = parseListings({ listings: [
  { id: 'ext', item_kind: 'gold', quantity: 1_000_000, price_usd: 5.0, currency: 'zenko', seller: 'EXTERNAL' }, // external: $0.000005/u
  { id: 'own', item_kind: 'gold', quantity: 1_000_000, price_usd: 1.0, currency: 'zenko', seller: 'OURS1' },    // ours (cheaper) — must be ignored
  { id: 'ext-relic', item_kind: 'relic', quantity: 1, price_usd: 4.0, currency: 'zenko', seller: 'EXTERNAL' },
  { id: 'own-relic', item_kind: 'relic', quantity: 1, price_usd: 1.0, currency: 'zenko', seller: 'OURS2' },
]});
const fleet = ['OURS1', 'OURS2'];
ok(Math.abs(goldFloorUsd(fleetSample, { fleetWallets: fleet }) - 0.000005) < 1e-12, 'gold floor excludes own fleet listing');
ok(Math.abs(goldFloorUsd(fleetSample) - 0.000001) < 1e-12, 'gold floor includes own when no fleet set (back-compat)');
ok(marketFloorUsd(fleetSample, { itemKind: 'relic', fleetWallets: fleet }) === 4.0, 'relic floor excludes own fleet listing');
ok(marketFloorUsd(fleetSample, { itemKind: 'relic' }) === 1.0, 'relic floor includes own when no fleet set');

let threw = false; try { parseListings({}); } catch { threw = true; }
ok(threw, 'parseListings throws on missing listings');

// own active listings: browse?mine=1 returns active rows, but cancelled/sold/expired rows
// are ignored if the API ever includes them.
const ownListings = [
  { id: 'mine-g1', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko', status: 'active' },
  { id: 'mine-g2', itemKind: 'gold', amount: 50000, priceUsd: 0.1, currency: 'zenko' },
  { id: 'mine-sold', item_kind: 'gold', quantity: 50000, price_usd: 0.1, currency: 'zenko', status: 'sold' },
  { id: 'mine-cancel', item_kind: 'gold', quantity: 50000, price_usd: 0.1, currency: 'zenko', status: 'cancelled' },
  { id: 'mine-relic', item_kind: 'relic', price_usd: 1.2, currency: 'zenko', status: 'listed' },
  { id: 'mine-gems', item_kind: 'gold', quantity: 10000, price_gems: 5, currency: 'gems', status: 'active' },
];
ok(activeListingCount(ownListings) === 4, `counts active own listings (${activeListingCount(ownListings)})`);
ok(activeListingCount(ownListings, { itemKind: 'gold' }) === 3,
  `counts active own gold listings (${activeListingCount(ownListings, { itemKind: 'gold' })})`);
ok(activeListingCount(ownListings, { itemKind: 'gold', currency: 'zenko' }) === 2,
  `counts active own zenko gold listings (${activeListingCount(ownListings, { itemKind: 'gold', currency: 'zenko' })})`);

const readClient = {
  calls: [],
  async api(path, body) {
    this.calls.push({ path, body });
    return { listings: ownListings };
  },
};
const myListings = await getMyListings(readClient);
ok(readClient.calls[0].path === '/api/market/browse?mine=1', `getMyListings path ${readClient.calls[0].path}`);
ok(readClient.calls[0].body === undefined, 'getMyListings is bodyless GET');
ok(myListings.length === ownListings.length, `getMyListings parses listings (${myListings.length})`);
const myGoldListings = await getMyGoldListings(readClient);
ok(readClient.calls[1].path === '/api/market/browse?mine=1&kind=gold', `getMyGoldListings path ${readClient.calls[1].path}`);
ok(readClient.calls[1].body === undefined, 'getMyGoldListings is bodyless GET');
ok(myGoldListings.every((row) => row.itemKind === 'gold'), 'getMyGoldListings filters gold rows');

// weighted exit lane: 1 Gold attempt to 3 creature attempts.
const laneCfg = { cashoutGoldWeight: 1, cashoutCreatureWeight: 3 };
ok(chooseCashoutLane({ rng: () => 0, cfg: laneCfg }) === 'gold', 'weighted lane low roll chooses gold');
ok(chooseCashoutLane({ rng: () => 0.249, cfg: laneCfg }) === 'gold', 'weighted lane boundary stays gold');
ok(chooseCashoutLane({ rng: () => 0.25, cfg: laneCfg }) === 'creature', 'weighted lane 75% range chooses creature');
ok(chooseCashoutLane({ rng: () => 0.99, cfg: laneCfg }) === 'creature', 'weighted lane high roll chooses creature');
ok(chooseCashoutLane({ rng: () => 0.5, cfg: { cashoutGoldWeight: 0, cashoutCreatureWeight: 0 } }) === null,
  'weighted lane returns null when all weights disabled');

// ── isDoneScaling ──
const CFG = { cashoutDepthTarget: 25, cashoutPlateauTicks: 20, cashoutGoldReserve: 50000,
  cashoutMinLotGold: 50000, cashoutMinPriceUsd: 0.05, cashoutChunkFracMin: 0.2,
  cashoutChunkFracMax: 0.5, cashoutPriceJitterMin: 0.97, cashoutPriceJitterMax: 1.02 };
ok(isDoneScaling({ ceiling: 25, ceilingStableTicks: 0, cfg: CFG }) === true, 'done at depth target');
ok(isDoneScaling({ ceiling: 7, ceilingStableTicks: 20, cfg: CFG }) === true, 'done on plateau');
ok(isDoneScaling({ ceiling: 7, ceilingStableTicks: 5, cfg: CFG }) === false, 'not done: still climbing');

// ── planGoldListing ──
const rng = () => 0.5; // deterministic midpoint
const plan = planGoldListing({ surplus: 300000, floorUsd: 0.000002, rng, cfg: CFG });
ok(plan !== null, 'plans a listing for 300k surplus');
ok(plan.quantity >= CFG.cashoutMinLotGold && plan.quantity <= 300000, `qty in range ${plan.quantity}`);
ok(plan.quantity % 10 !== 0, `qty non-round ${plan.quantity}`);
ok(plan.priceUsd === Math.round(plan.priceUsd * 100) / 100, '2-decimal price');
ok(plan.priceUsd >= CFG.cashoutMinPriceUsd, `price >= min ${plan.priceUsd}`);
ok(plan.priceUsd >= Math.ceil(plan.quantity * 0.000002 * 100) / 100, 'gold listing never rounds below floor');
ok(planGoldListing({ surplus: 1000, floorUsd: 0.000002, rng, cfg: CFG }) === null, 'null when surplus < min lot');
ok(planGoldListing({ surplus: 300000, floorUsd: null, rng, cfg: CFG }) === null, 'null when no floor');
const exactSurplusPlan = planGoldListing({
  surplus: 100000,
  floorUsd: 0.000002,
  rng: () => 0,
  cfg: { ...CFG, cashoutChunkFracMin: 1, cashoutChunkFracMax: 1 },
});
ok(exactSurplusPlan.quantity <= 100000, `clamps non-round quantity to surplus (${exactSurplusPlan.quantity})`);
const atFloorPlan = planGoldListing({
  surplus: 200000,
  floorUsd: 0.000002,
  rng: () => 0.5,
  cfg: { ...CFG, cashoutPriceJitterMin: 1, cashoutPriceJitterMax: 1 },
});
ok(atFloorPlan.priceUsd >= Math.ceil(atFloorPlan.quantity * 0.000002 * 100) / 100, 'floor mode prices gold at or above floor');
const uniquePlan = planUniqueFloorListing({ floorUsd: 0.101, cfg: CFG });
ok(uniquePlan.priceUsd === 0.11, `unique listing ceils to floor cents (${uniquePlan.priceUsd})`);

// ── conservative junk selection ──
const junkRelics = pickJunkRelics([
  { id: 'r1', rarity: 'Common', stat: 'Attack', value: 4 },
  { id: 'r2', rarity: 'Common', stat: 'Attack', value: 3 },
  { id: 'r3', rarity: 'Common', stat: 'Attack', value: 2 },
  { id: 'r4', rarity: 'Common', stat: 'Attack', value: 1, equipped_on: 'c1' },
  { id: 'r5', rarity: 'Rare', stat: 'Attack', value: 10 },
  { id: 'r6', rarity: 'Common', stat: 'Defense', value: 1, listed: true },
], { junkRelicRarities: ['common'], junkRelicKeepPerKey: 2 });
ok(junkRelics.length === 1 && junkRelics[0].id === 'r3', `keeps best safe common relics (${junkRelics.map(r => r.id).join(',')})`);

const junkCreatures = pickJunkCreatures([
  { id: 'c1', species: 'Cobble', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 3 },
  { id: 'c2', species: 'Cobble', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 2 },
  { id: 'c3', species: 'Cobble', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 1 },
  { id: 'c4', species: 'Cobble', rarity: 'Common', variant: 'Shiny', stage: 'Baby', level: 1 },
  { id: 'c5', species: 'Cobble', rarity: 'Common', variant: 'Normal', stage: 'Adult', level: 1 },
  { id: 'c6', species: 'Dimble', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 1, bound: true },
], { junkCreatureRarities: ['common'], junkCreatureKeepPerSpecies: 2 });
ok(junkCreatures.length === 1 && junkCreatures[0].id === 'c3', `keeps best safe common creature duplicates (${junkCreatures.map(c => c.id).join(',')})`);
const manyJunkCreatures = pickJunkCreatures([
  { id: 'j1', species: 'Moss', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 5 },
  { id: 'j2', species: 'Moss', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 4, favorite: true },
  { id: 'j3', species: 'Moss', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 3 },
  { id: 'j4', species: 'Moss', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 2 },
  { id: 'j5', species: 'Moss', rarity: 'Common', variant: 'Normal', stage: 'Baby', level: 1 },
], { junkCreatureRarities: ['common'], junkCreatureKeepPerSpecies: 2 });
ok(manyJunkCreatures.map(c => c.id).join(',') === 'j5,j4',
  `sells weakest non-favorite junk first (${manyJunkCreatures.map(c => c.id).join(',')})`);

const repriceCfg = { cashoutRepriceMinAgeMs: 4 * 60 * 60 * 1000, cashoutRepriceMinDropPct: 0.05, cashoutMinPriceUsd: 0.05 };
ok(planListingReprice({
  listing: { id: 'fresh', itemKind: 'gold', amount: 100000, priceUsd: 0.5, currency: 'zenko', listedAt: '2026-07-04T11:00:00Z' },
  floorUsd: 0.000002,
  now: Date.parse('2026-07-04T12:00:00Z'),
  cfg: repriceCfg,
}) === null, 'does not reprice fresh listing');
const staleGoldReprice = planListingReprice({
  listing: { id: 'stale-gold', itemKind: 'gold', amount: 100000, priceUsd: 0.5, currency: 'zenko', listedAt: '2026-07-04T06:00:00Z' },
  floorUsd: 0.000002,
  now: Date.parse('2026-07-04T12:00:00Z'),
  cfg: repriceCfg,
});
ok(staleGoldReprice?.newPriceUsd === 0.2 && staleGoldReprice?.dropPct > 0.5,
  `reprices stale overpriced gold (${JSON.stringify(staleGoldReprice)})`);
ok(planListingReprice({
  listing: { id: 'fair', itemKind: 'creature', itemId: 'c1', priceUsd: 0.2, currency: 'zenko', listedAt: '2026-07-04T06:00:00Z' },
  floorUsd: 0.2,
  now: Date.parse('2026-07-04T12:00:00Z'),
  cfg: repriceCfg,
}) === null, 'does not reprice fair unique listing');

// ── saleLedgerAmounts (gold carries a gold delta; unique items only credit $ZOLANA) ──
const goldSale = saleLedgerAmounts({ item_kind: 'gold', quantity: 100000, price_usd: 0.2 }, 0.0002);
ok(goldSale.kind === 'gold' && goldSale.amounts.gold === -100000, `gold sale gold delta ${goldSale.amounts.gold}`);
ok(Math.abs(goldSale.amounts.zolana - 1000) < 1e-6, `gold sale zolana ${goldSale.amounts.zolana}`); // 0.2/0.0002
const creatureSale = saleLedgerAmounts({ item_kind: 'creature', item_id: 'x', price_usd: 0.5 }, 0.0002);
ok(creatureSale.amounts.gold === undefined, 'creature sale has no gold delta');
ok(Math.abs(creatureSale.amounts.zolana - 2500) < 1e-6, `creature sale zolana ${creatureSale.amounts.zolana}`);
ok(saleLedgerAmounts({ item_kind: 'relic', price_usd: 1 }, 0).amounts.zolana === 0, 'no price → 0 zolana');
// buyer captured for the "who buys from us" log
ok(saleLedgerAmounts({ item_kind: 'creature', item_id: 'x', price_usd: 0.5, buyer: 'BUYER1' }, 0.0002).buyer === 'BUYER1', 'captures buyer wallet');
ok(saleLedgerAmounts({ item_kind: 'gold', quantity: 1, price_usd: 0.1 }, 0).buyer === null, 'buyer null when absent');

// ── newlySold ──
const sales = [{ id: 's1', quantity: 100000, price_usd: 0.2 }, { id: 's2', quantity: 50000, price_usd: 0.1 }];
ok(newlySold(new Set(['s1']), sales).length === 1, 'detects one new sale');
ok(newlySold(new Set(['s1']), sales)[0].id === 's2', 'new sale is s2');
ok(newlySold(new Set(['s1', 's2']), sales).length === 0, 'no new sales');

// ── creature floor by rarity in $ZOLANA (real sales, fleet excluded) ──
const salesJson = { sales: [
  { item_kind:'creature', price_usd:0.10, currency:'zenko', rarity:'Common', seller:'EXT' },
  { item_kind:'creature', price_usd:0.06, currency:'zenko', rarity:'Common', seller:'OURS' }, // ours — excluded
  { item_kind:'creature', price_usd:0.50, currency:'zenko', rarity:'Rare', seller:'EXT' },
  { item_kind:'creature', price_usd:2.00, currency:'zenko', rarity:'Epic', seller:'EXT' },
  { item_kind:'creature', price_gems:5, currency:'gems', rarity:'Rare', seller:'EXT' }, // gems lane — ignored
  { item_kind:'gold', price_usd:1.0, currency:'zenko', seller:'EXT' }, // not a creature — ignored
]};
const fbr = creatureFloorZolanaByRarity(parseSales(salesJson), { zolanaPriceUsd: 0.0002, fleetWallets: ['OURS'] });
ok(fbr.common === 500, `common floor excludes own sale (0.10/0.0002=500), got ${fbr.common}`);
ok(fbr.rare === 2500, `rare floor in ZOLANA (0.50/0.0002=2500), got ${fbr.rare}`);
ok(fbr.epic === 10000, `epic floor in ZOLANA (2.00/0.0002=10000), got ${fbr.epic}`);
ok(fbr.uncommon === undefined, 'no uncommon sales → no uncommon floor');
ok(Object.keys(creatureFloorZolanaByRarity(parseSales(salesJson), { zolanaPriceUsd: 0 })).length === 0, 'no token price → empty floors');

// ── sale COUNT by rarity (2026-07-06, feeds the volume pane of the per-rarity candlestick chart) ──
const scr = salesCountByRarity(parseSales(salesJson), { fleetWallets: ['OURS'] });
ok(scr.common === 1, `common count excludes own sale (got ${scr.common})`);
ok(scr.rare === 1, `rare count excludes the gems-lane sale (got ${scr.rare})`);
ok(scr.epic === 1, `epic count (got ${scr.epic})`);
ok(scr.uncommon === undefined, 'no uncommon sales → no key at all (matches creatureFloorZolanaByRarity)');
ok(salesCountByRarity([]).common === undefined, 'empty sales → empty object');
// no token price needed for a pure count — unlike floor, this must NOT require zolanaPriceUsd.
// Without fleetWallets, nothing is excluded (correct: no fleet to exclude) — both common sales count.
ok(salesCountByRarity(parseSales(salesJson), {}).common === 2, 'works without a price param at all; without fleetWallets nothing is excluded');

// getCreatureFloorAndVolumeByRarity: single fetch, both floors+counts from the SAME raw response
// (not two separate network round-trips) — 2026-07-06.
{
  let calls = 0;
  const client = { api: async () => { calls++; return salesJson; } };
  const result = await getCreatureFloorAndVolumeByRarity(client, { zolanaPriceUsd: 0.0002, fleetWallets: ['OURS'] });
  ok(calls === 1, `single network call (got ${calls})`);
  ok(result.floors.rare === 2500 && result.counts.rare === 1, `shares one fetch for both floors and counts (got ${JSON.stringify(result)})`);
}

// ── creature listing price is rarity-aware (2026-07-05 fix: was rarity-blind marketFloorUsd,
//    Rare could list at the cheapest Common/Uncommon lot on the whole market) ──
ok(creatureFloorUsdForRarity('rare', fbr, 0.0002) === 0.5, `live per-rarity floor wins (2500 zolana × 0.0002 = 0.50), got ${creatureFloorUsdForRarity('rare', fbr, 0.0002)}`);
ok(creatureFloorUsdForRarity('Rare', {}, 0.03) === CREATURE_FLOOR_SEED_USD.rare, 'no live data → owner seed fallback (case-insensitive rarity)');
ok(creatureFloorUsdForRarity('rare', { rare: 0 }, 0.03) === CREATURE_FLOOR_SEED_USD.rare, 'zero live floor → treated as missing, falls back to seed');
ok(creatureFloorUsdForRarity('rare', fbr, 0) === CREATURE_FLOOR_SEED_USD.rare, 'live floor present but no token price → cannot convert, falls back to seed');
ok(creatureFloorUsdForRarity('legendary', fbr, 0.0002) === null, 'no live data and no seed for this rarity → null (skip listing, do not invent a price)');
ok(creatureFloorUsdForRarity('uncommon', fbr, 0.0002) === CREATURE_FLOOR_SEED_USD.uncommon, 'uncommon also has an owner seed now, used when live data is missing');
ok(creatureFloorUsdForRarity('epic', fbr, 0.0002) === 2, `live epic floor still wins when present (10000×0.0002=2.00), got ${creatureFloorUsdForRarity('epic', fbr, 0.0002)}`);

// VARIANT PRICE OVERRIDE (2026-07-06, friend: «анкамон рейнбоу... по 0.2»): a specific (rarity,variant)
// override beats BOTH the live per-rarity floor AND the rarity seed — neither of those distinguishes
// variant, so reusing them for a Rainbow would misprice it (almost certainly underprice it).
ok(creatureFloorUsdForRarity('uncommon', fbr, 0.0002, 'rainbow') === CREATURE_VARIANT_PRICE_OVERRIDE_USD['uncommon:rainbow'],
  `rainbow override wins even though a live uncommon floor exists (got ${creatureFloorUsdForRarity('uncommon', fbr, 0.0002, 'rainbow')})`);
ok(creatureFloorUsdForRarity('uncommon', {}, 0, 'rainbow') === CREATURE_VARIANT_PRICE_OVERRIDE_USD['uncommon:rainbow'],
  'rainbow override wins even with zero live data at all (not dependent on a fallback chain)');
ok(creatureFloorUsdForRarity('uncommon', fbr, 0.0002, 'Rainbow') === CREATURE_VARIANT_PRICE_OVERRIDE_USD['uncommon:rainbow'],
  'variant match is case-insensitive');
ok(creatureFloorUsdForRarity('uncommon', fbr, 0.0002, 'normal') !== CREATURE_VARIANT_PRICE_OVERRIDE_USD['uncommon:rainbow'],
  'a non-overridden variant at the same rarity is unaffected — falls through to the normal live-floor/seed chain');
ok(creatureFloorUsdForRarity('rare', fbr, 0.0002, 'rainbow') === 0.5,
  'no override exists for rare:rainbow → falls through to the live rare floor untouched');

// ── write guard ──
let blocked = false; try { assertWriteAllowed('/api/market/buy'); } catch { blocked = true; }
ok(blocked, 'write guard blocks /api/market/buy');
let blocked2 = false; try { assertWriteAllowed('/api/market/quote'); } catch { blocked2 = true; }
ok(blocked2, 'write guard blocks /api/market/quote');
let allow = true; try { assertWriteAllowed('/api/market/list'); } catch { allow = false; }
ok(allow, 'write guard allows /api/market/list');

// ── recycle (sacrifice → XP) selection — SAFETY: what becomes fodder vs what is protected ──
const recRoster = [
  { id:'c1', species:'seedlup', rarity:'Common',    variant:'Normal', stage:'Juvenile', level:9 },   // fodder
  { id:'u1', species:'smoldra', rarity:'Uncommon',  variant:'Normal', stage:'Juvenile', level:11 },  // fodder
  { id:'r1', species:'florix',  rarity:'Rare',      variant:'Normal', stage:'Juvenile', level:10 },  // keep (rare)
  { id:'e1', species:'thornmaw',rarity:'Epic',      variant:'Normal', stage:'Adult',    level:12 },  // keep (epic) → target
  { id:'l1', species:'geargrove',rarity:'Legendary',variant:'Normal', stage:'Baby',     level:5 },   // keep (leg)
  { id:'gd', species:'flicky',  rarity:'Common',    variant:'Golden', stage:'Adult',    level:13 },  // PROTECT (special variant)
  { id:'sh', species:'cindle',  rarity:'Common',    variant:'Shadow', stage:'Adult',    level:15 },  // PROTECT
  { id:'shy',species:'gloopy',  rarity:'Common',    variant:'Shiny',  stage:'Adult',    level:10 },  // fodder (Shiny demoted 2026-07-05: treated like Normal)
  { id:'fav',species:'gusty',   rarity:'Common',    variant:'Normal', stage:'Adult',    level:12, favorite:true }, // protect (favorite)
  { id:'pl', species:'clovy',   rarity:'Common',    variant:'Normal', stage:'Adult',    level:12, plot_x:3 },      // protect (placed)
  { id:'busy',species:'cobble', rarity:'Common',    variant:'Normal', stage:'Adult',    level:12 },  // protect (busy)
];
const fodder = pickRecycleFodder(recRoster, { busyIds: new Set(['busy']) });
const fodderIds = new Set(fodder.map(c => c.id));
ok(fodderIds.has('c1') && fodderIds.has('u1'), 'default fodder includes Common+Uncommon normal');
// farm profile config: только Common → XP, Uncommon (зелёных) оставляем в скваде
const commonOnly = pickRecycleFodder(recRoster, { recycleFodderRarities: ['common'], busyIds: new Set(['busy']) });
const commonIds = new Set(commonOnly.map(c => c.id));
ok(commonIds.has('c1'), 'common-only fodder includes Common');
ok(!commonIds.has('u1'), 'common-only fodder EXCLUDES Uncommon (kept in squad)');
// run_id: pet out on a run must never be fodder (else server 409 "out on a run")
const inRunRoster = [
  { id: 'idle', rarity: 'Common', variant: 'Normal', stage: 'Adult', level: 5 },
  { id: 'running', rarity: 'Common', variant: 'Normal', stage: 'Adult', level: 5, run_id: 'run-abc' },
];
const inRunFodder = new Set(pickRecycleFodder(inRunRoster, { recycleFodderRarities: ['common'] }).map(c => c.id));
ok(inRunFodder.has('idle'), 'idle common is fodder');
ok(!inRunFodder.has('running'), 'common WITH run_id excluded from fodder (no 409)');
ok(isInRun({ run_id: 'x' }) && !isInRun({ run_id: null }), 'isInRun detects run_id');
ok(!fodderIds.has('r1') && !fodderIds.has('e1') && !fodderIds.has('l1'), 'fodder excludes Rare/Epic/Legendary');
ok(!fodderIds.has('gd') && !fodderIds.has('sh'), 'fodder NEVER includes Golden/Shadow');
ok(fodderIds.has('shy'), 'Shiny Common IS fodder (2026-07-05: Shiny demoted, treated like Normal)');
ok(!fodderIds.has('fav') && !fodderIds.has('pl') && !fodderIds.has('busy'), 'fodder excludes favorite/placed/busy');
ok(fodder.length === 3, `exactly 3 fodder from this roster incl. Shiny (got ${fodder.length})`);
ok(isSpecialVariant('Rainbow') && isSpecialVariant('Shiny') && !isSpecialVariant('Normal'), 'isSpecialVariant (sell-path use): any non-normal, Shiny included');
ok(isProtectedVariant('Golden') && isProtectedVariant('Shadow') && isProtectedVariant('Rainbow'), 'isProtectedVariant (recycle-path use): Golden/Shadow/Rainbow');
ok(!isProtectedVariant('Shiny') && !isProtectedVariant('Normal'), 'isProtectedVariant: Shiny is NOT protected (owner 2026-07-05), same as Normal');

// BOUND: sacrifice is self-consumption for XP, NOT a trade → bound blocks SELLING, not fodder.
// Regression: excluding bound here froze the whole flywheel (≈96% of farm commons are bound:
// onboarding stock + bred offspring). Bound normal commons MUST be valid fodder.
const boundRoster = [
  { id:'bc', species:'nimbu',  rarity:'Common', variant:'Normal', stage:'Adult', level:8, bound:true }, // fodder (bound normal common)
  { id:'bs', species:'flicky', rarity:'Common', variant:'Golden', stage:'Adult', level:9, bound:true }, // PROTECT (bound but special variant)
];
const boundFodder = new Set(pickRecycleFodder(boundRoster, { recycleFodderRarities: ['common'] }).map(c => c.id));
ok(boundFodder.has('bc'), 'BOUND normal common IS fodder (sacrifice ≠ trade; bound blocks only selling)');
ok(!boundFodder.has('bs'), 'bound + special variant still protected from fodder');
// sell path MUST stay unchanged: bound can never be listed
const boundSell = new Set(pickJunkCreatures(boundRoster, { junkCreatureRarities: ['common'], junkCreatureStages: ['Adult'], junkCreatureVariants: ['normal', ''], junkCreatureKeepPerSpecies: 0 }).map(c => c.id));
ok(!boundSell.has('bc'), 'bound common still EXCLUDED from selling (bound blocks trade, not sacrifice)');

// EXHAUSTED-BREEDER retirement (friend's strategy): a Uncommon that used all 8 breeds → XP fodder;
// an un-exhausted Uncommon (breeding stock) is kept; an exhausted Rare is HELD (not recycled, sold later).
const exhaustRoster = [
  { id:'u_spent', species:'quartz', rarity:'Uncommon', variant:'Normal', stage:'Adult', level:8, breed_count:8 },
  { id:'u_stock', species:'quartz', rarity:'Uncommon', variant:'Normal', stage:'Adult', level:8, breed_count:3 },
  { id:'r_spent', species:'geo',    rarity:'Rare',     variant:'Normal', stage:'Adult', level:9, breed_count:8 },
  { id:'u_shy_spent', species:'brambark', rarity:'Uncommon', variant:'Shiny', stage:'Adult', level:8, breed_count:8 }, // Shiny exhausted → XP (as Normal)
  { id:'u_gold_spent', species:'petalbud', rarity:'Uncommon', variant:'Golden', stage:'Adult', level:8, breed_count:8 }, // Golden still protected even when exhausted
];
const exCfg = { recycleFodderRarities: ['common'], recycleExhaustedRarities: ['uncommon'], breedMaxCount: 8 };
const exFodder = new Set(pickRecycleFodder(exhaustRoster, exCfg).map(c => c.id));
ok(exFodder.has('u_spent'), 'exhausted 8/8 Uncommon → XP fodder');
ok(!exFodder.has('u_stock'), 'un-exhausted Uncommon kept as breeding stock (not recycled)');
ok(!exFodder.has('r_spent'), 'exhausted Rare is NOT recycled (held for later sale)');
ok(exFodder.has('u_shy_spent'), 'exhausted 8/8 SHINY Uncommon → XP fodder too (owner: shiny uncommon = обычная анкомонка)');
ok(!exFodder.has('u_gold_spent'), 'exhausted 8/8 GOLDEN Uncommon still protected (only Shiny demoted)');

// BUG FIX: placed fodder must be unplaceable so it can be recycled (place-auto parks commons on
// island plots → excluded from sacrifice → stuck forever, never converted to XP).
const placedRoster = [
  { id:'cp', rarity:'Common',   variant:'Normal', stage:'Adult', level:5, plot_x:2 },          // placed common → unplace target
  { id:'cf', rarity:'Common',   variant:'Normal', stage:'Adult', level:5 },                    // free common → NOT here (already recyclable)
  { id:'cs', rarity:'Common',   variant:'Golden', stage:'Adult', level:5, plot_x:3 },          // placed special → protected
  { id:'cshy', rarity:'Common', variant:'Shiny',  stage:'Adult', level:5, plot_x:8 },          // placed Shiny → unplace target too (demoted)
  { id:'cr', rarity:'Common',   variant:'Normal', stage:'Adult', level:5, plot_x:4, run_id:'r' }, // placed but in run → skip (409)
  { id:'ue', rarity:'Uncommon', variant:'Normal', stage:'Adult', level:8, plot_x:5, breed_count:8 }, // placed exhausted uncommon → unplace
  { id:'us', rarity:'Uncommon', variant:'Normal', stage:'Adult', level:8, plot_x:6, breed_count:2 }, // placed un-exhausted uncommon → keep (stock)
  { id:'rp', rarity:'Rare',     variant:'Normal', stage:'Adult', level:9, plot_x:7 },           // placed rare → never fodder
];
const placedFodder = new Set(pickPlacedFodder(placedRoster, { recycleFodderRarities:['common'], recycleExhaustedRarities:['uncommon'], breedMaxCount:8 }).map(c=>c.id));
ok(placedFodder.has('cp'), 'placed common IS unplace-fodder (frees it for XP)');
ok(!placedFodder.has('cf'), 'free common not in placed-fodder (already recyclable)');
ok(!placedFodder.has('cs'), 'placed Golden common still protected');
ok(placedFodder.has('cshy'), 'placed Shiny common IS unplace-fodder too (demoted, treated like Normal)');
ok(!placedFodder.has('cr'), 'placed but in-run common skipped (avoids 409)');
ok(placedFodder.has('ue'), 'placed exhausted 8/8 Uncommon IS unplace-fodder');
ok(!placedFodder.has('us'), 'placed un-exhausted Uncommon kept (breeding stock)');
ok(!placedFodder.has('rp'), 'placed Rare never unplace-fodder');

// VAULT candidate («рарки в сейф», roster-full pressure valve): least-valuable idle Rare+, keeping
// the strongest N as dungeon runners; never commons/uncommons, never busy/favorite, never recycle target.
const vaultRoster = [
  { id:'leg', rarity:'Legendary', stage:'Elder',  level:20 },                 // strongest → keep
  { id:'epi', rarity:'Epic',      stage:'Adult',  level:12 },
  { id:'rar1',rarity:'Rare',      stage:'Adult',  level:9 },
  { id:'rar2',rarity:'Rare',      stage:'Baby',   level:2 },                   // least valuable Rare+ → vault
  { id:'busy',rarity:'Rare',      stage:'Adult',  level:9, run_id:'r' },       // in run → never
  { id:'com', rarity:'Common',    stage:'Adult',  level:9 },                   // not Rare+ → never
];
const vc = pickVaultCandidate(vaultRoster, { vaultKeepStrongestRareplus: 0 });
ok(vc && vc.id === 'rar2', `vault least-valuable idle Rare+ (Baby Rare), got ${vc && vc.id}`);
ok(!pickVaultCandidate(vaultRoster, {}, { protectId: 'rar2' }) || pickVaultCandidate(vaultRoster, {}, { protectId: 'rar2' }).id !== 'rar2', 'never vaults the protected recycle target');
const vcKeep = pickVaultCandidate(vaultRoster, { vaultKeepStrongestRareplus: 4 }); // keep top4 of 4 idle Rare+ → none left
ok(vcKeep === null, 'keepStrongest protects all runners → nothing to vault');
ok(pickVaultCandidate([{ id:'c', rarity:'Common', stage:'Adult', level:5 }], {}) === null, 'no Rare+ → null (never vault commons)');
ok(pickVaultCandidate([{ id:'r', rarity:'Rare', stage:'Adult', level:9, is_favorite:true }], {}) === null, 'favorite Rare never vaulted');

// VAULT SWAP (флот↔сейф continuous polish, 2026-07-05): pickVaultCandidate is one-shot and forgets —
// stored creatures never come back on their own. planVaultSwap admits the strongest stored Rare+ when
// it clearly beats (by vaultSwapMinValueMargin) the weakest EVICTABLE active Rare+, swapping the two.
const swapRoster = [
  { id:'strong-active', rarity:'Legendary', stage:'Elder',  level:20 },                // way too strong to ever evict
  { id:'weak-active',   rarity:'Rare',      stage:'Baby',   level:1 },                  // weakest active → evict candidate
  { id:'mid-active',    rarity:'Rare',      stage:'Baby',   level:2 },                  // 2nd weakest, still swap-eligible
  { id:'weak-stored',   rarity:'Rare',      stage:'Baby',   level:3, stored:true },     // barely better than weak-active — not enough
  { id:'strong-stored', rarity:'Epic',      stage:'Adult',  level:10, stored:true },    // clearly better → admit candidate
  { id:'busy-active',   rarity:'Rare',      stage:'Adult',  level:9, run_id:'r' },      // in a run → not evictable
];
const swap = planVaultSwap(swapRoster, {});
ok(swap && swap.evict.id === 'weak-active' && swap.admit.id === 'strong-stored',
  `swap evicts weakest evictable active, admits strongest stored (got ${JSON.stringify(swap)})`);
ok(planVaultSwap(swapRoster, { vaultSwapMinValueMargin: 1e9 }) === null,
  'margin requirement too high → no swap even though a valid pair exists');
ok(planVaultSwap([{ id:'a', rarity:'Rare', stage:'Adult', level:5 }], {}) === null,
  'no stored Rare+ at all → null');
ok(planVaultSwap([{ id:'s', rarity:'Rare', stage:'Adult', level:5, stored:true }], {}) === null,
  'no active Rare+ at all → null');
const swapProtected = planVaultSwap(swapRoster, {}, { protectId: 'weak-active' });
ok(swapProtected && swapProtected.evict.id === 'mid-active',
  `protected recycle target is skipped, next-weakest evicted instead (got ${JSON.stringify(swapProtected)})`);

// BREEDING INTAKE / GRADUATE (dedicated vault-breeding pool, 2026-07-06): intake pulls fresh
// (breed_count<8) Adult+ Uncommon/Rare INTO the vault to breed for free; graduate pulls exhausted
// (breed_count>=8) ones back OUT so the normal sell path can see them (isInRun treats stored as busy).
const intakeRoster = [
  { id: 'strong-runner', rarity: 'Legendary', stage: 'Elder', level: 20, breed_count: 0 },      // keepStrongest protects this
  { id: 'weak-uncommon', rarity: 'Uncommon', stage: 'Adult', level: 3, breed_count: 2 },          // least valuable → intake candidate
  { id: 'mid-rare', rarity: 'Rare', stage: 'Adult', level: 8, breed_count: 5 },
  { id: 'exhausted-rare', rarity: 'Rare', stage: 'Adult', level: 8, breed_count: 8 },              // already exhausted → NOT an intake candidate
  { id: 'baby-uncommon', rarity: 'Uncommon', stage: 'Baby', level: 1, breed_count: 0 },            // not Adult+ → can't breed yet
  { id: 'already-vaulted', rarity: 'Uncommon', stage: 'Adult', level: 5, breed_count: 1, stored: true },
  { id: 'busy-rare', rarity: 'Rare', stage: 'Adult', level: 9, breed_count: 0, run_id: 'r1' },
];
const intake = pickBreedingIntake(intakeRoster, {});
ok(intake && intake.id === 'weak-uncommon', `intake picks the least valuable free Adult+ non-exhausted (got ${intake && intake.id})`);
ok(pickBreedingIntake(intakeRoster, { vaultBreedingKeepStrongest: 99 }) === null, 'keepStrongest above pool size → nothing to intake');
ok(pickBreedingIntake([{ id: 'c', rarity: 'Common', stage: 'Adult', level: 5, breed_count: 0 }], {}) === null, 'Common not in default vaultBreedingRarities → null');
ok(pickBreedingIntake([], {}) === null, 'empty roster → null');

const graduateRoster = [
  { id: 'fresh-vaulted', rarity: 'Uncommon', stage: 'Adult', level: 5, breed_count: 3, stored: true },
  { id: 'exhausted-vaulted', rarity: 'Rare', stage: 'Adult', level: 8, breed_count: 8, stored: true },
  { id: 'exhausted-active', rarity: 'Rare', stage: 'Adult', level: 8, breed_count: 8, stored: false }, // not stored → not a graduate candidate (nothing to un-vault)
];
const grad = pickBreedingGraduate(graduateRoster, {});
ok(grad && grad.id === 'exhausted-vaulted', `graduate picks the exhausted STORED creature only (got ${grad && grad.id})`);
ok(pickBreedingGraduate([{ id: 'x', rarity: 'Uncommon', stage: 'Adult', level: 5, breed_count: 3, stored: true }], {}) === null, 'not yet exhausted → null, stays in vault breeding');
ok(pickBreedingGraduate([], {}) === null, 'empty roster → null');

// JUNK SELL breed-exhaustion gate (junkMinBreedCount, 2026-07-06): protects live breeding stock from
// being swept into a market listing before it has used up its breed attempts.
const junkBreedRoster = [
  { id: 'fresh', rarity: 'Uncommon', variant: 'normal', stage: 'Adult', breed_count: 2 },
  { id: 'done', rarity: 'Uncommon', variant: 'normal', stage: 'Adult', breed_count: 8 },
];
ok(pickJunkCreatures(junkBreedRoster, { junkCreatureRarities: ['uncommon'], junkCreatureStages: ['Adult'], junkCreatureKeepPerSpecies: 0 }).length === 2,
  'junkMinBreedCount unset (0) → old behavior, both eligible');
const gatedJunk = pickJunkCreatures(junkBreedRoster, { junkCreatureRarities: ['uncommon'], junkCreatureStages: ['Adult'], junkCreatureKeepPerSpecies: 0, junkMinBreedCount: 8 });
ok(gatedJunk.length === 1 && gatedJunk[0].id === 'done', `junkMinBreedCount:8 → only the exhausted one is sellable (got ${JSON.stringify(gatedJunk.map(c=>c.id))})`);

// VARIANT/RARITY SELL OVERRIDE (junkVariantRarityOverrides, 2026-07-06, friend: «анкамон рейнбоу...
// в сейф, и по 0.2, на рынок»): a specific (rarity,variant) pair becomes sellable even though the
// variant itself isn't in the general junkCreatureVariants allowlist — WITHOUT widening eligibility
// for that variant at any OTHER rarity, and WITHOUT touching Golden/Shadow (untouched, still excluded).
const variantRoster = [
  { id: 'unc-rainbow-fresh', rarity: 'Uncommon', variant: 'Rainbow', stage: 'Adult', breed_count: 2 },  // not exhausted yet
  { id: 'unc-rainbow-done', rarity: 'Uncommon', variant: 'Rainbow', stage: 'Adult', breed_count: 8 },    // exhausted → sellable
  { id: 'unc-golden-done', rarity: 'Uncommon', variant: 'Golden', stage: 'Adult', breed_count: 8 },      // exhausted, but NOT overridden → stays protected
  { id: 'rare-rainbow-done', rarity: 'Rare', variant: 'Rainbow', stage: 'Adult', breed_count: 8 },       // exhausted Rainbow, but wrong RARITY for the override → stays protected
];
const overrideCfg = {
  junkCreatureRarities: ['uncommon', 'rare'], junkCreatureStages: ['Adult'], junkCreatureKeepPerSpecies: 0,
  junkMinBreedCount: 8, junkVariantRarityOverrides: ['uncommon:rainbow'],
};
const overridden = pickJunkCreatures(variantRoster, overrideCfg);
ok(overridden.length === 1 && overridden[0].id === 'unc-rainbow-done',
  `only the exhausted Uncommon Rainbow is sellable — not the fresh one, not Golden, not Rare Rainbow (got ${JSON.stringify(overridden.map(c=>c.id))})`);
ok(pickJunkCreatures(variantRoster, { ...overrideCfg, junkVariantRarityOverrides: [] }).length === 0,
  'without the override configured at all, Rainbow is never sellable regardless of exhaustion — confirms this is opt-in, not a silent default');

// pet floor valuation: mark-to-market counts ALL; unboundOnly excludes bound (unsellable = not cash)
const valRoster = [
  { rarity:'Uncommon', bound:false }, { rarity:'Uncommon', bound:true },
  { rarity:'Rare', bound:false }, { rarity:'Common', bound:false },
];
const valFloor = { uncommon: 2626, rare: 394, common: 0 };
ok(petFloorValueZolana(valRoster, valFloor) === 2626+2626+394+0, 'mark-to-market counts all incl bound');
ok(petFloorValueZolana(valRoster, valFloor, { unboundOnly:true }) === 2626+394+0, 'sellable value excludes bound');
ok(petFloorValueZolana([], valFloor) === 0 && petFloorValueZolana(valRoster, {}) === 0, 'empty list / no floor → 0');

// Task-1 organic pricing: symmetric ±jitter around floor (cluster like many independent sellers,
// NOT a floor−ε undercut wall). Timing/account randomness is emergent from per-account jitter + skip.
ok(planOrganicPrice({ floorUsd: 1.0, jitterPct: 0, rng: () => 0.5 }).priceUsd === 1.0, 'no jitter → exactly floor');
ok(planOrganicPrice({ floorUsd: 1.0, jitterPct: 0.1, rng: () => 0 }).priceUsd === 0.9, 'jitter low end = floor×(1−j)');
ok(planOrganicPrice({ floorUsd: 1.0, jitterPct: 0.1, rng: () => 1 }).priceUsd === 1.1, 'jitter high end = floor×(1+j)');
ok(planOrganicPrice({ floorUsd: 0 }) === null, 'no external floor → null (don not invent a price)');
ok(planOrganicPrice({ floorUsd: 0.01, jitterPct: 0.5, minPriceUsd: 0.05, rng: () => 0 }).priceUsd === 0.05, 'clamps to minPriceUsd');
let organicSum = 0; let oseed = 1; const oprng = () => { oseed = (oseed * 1103515245 + 12345) & 0x7fffffff; return oseed / 0x7fffffff; };
for (let i = 0; i < 2000; i++) organicSum += planOrganicPrice({ floorUsd: 100, jitterPct: 0.05, rng: oprng }).priceUsd;
ok(Math.abs(organicSum / 2000 - 100) < 0.5, `symmetric jitter averages ~floor, no downward drift (got ${(organicSum / 2000).toFixed(2)})`);

const target = pickRecycleTarget(recRoster, { busyIds: new Set(['busy']) });
ok(target && target.id === 'e1', `target = strongest keeper (Epic Adult L12), got ${target && target.id}`);
ok(!fodderIds.has(target.id), 'target is never in fodder set');
// no rare+ keeper → NO target → recycle skipped (don't strip an all-common account)
const onlyCommons = [{ id:'x', rarity:'Common', variant:'Normal', stage:'Adult', level:5 }];
ok(pickRecycleTarget(onlyCommons) === null, 'no target when no rare+ keeper (recycle waits for a rare)');

// VAULT AUDIT 2026-07-05: pickRecycleTarget must never pick a stored (vaulted) or in-run Rare+ as the
// XP-recipient — it was accepting a `busyIds` cfg param but silently ignoring it. A stored/busy target
// would make recycle fail its sacrifice call (target unreachable) or, worse, if vault's protectId came
// from this same buggy function, vault could pick the SAME creature it just excluded — for the wrong
// reason — letting a genuinely-idle strongest Rare+ get vaulted instead of the intended weakest one.
const targetRoster = [
  { id: 'stored_epic', rarity: 'Epic', stage: 'Elder', level: 30, stored: true },      // strongest by score, but IN THE SAFE
  { id: 'busy_legendary', rarity: 'Legendary', stage: 'Elder', level: 25, run_id: 'r1' }, // stronger still, but out on a run
  { id: 'idle_rare', rarity: 'Rare', stage: 'Adult', level: 9 },                        // the only real candidate
];
const safeTarget = pickRecycleTarget(targetRoster, { busyIds: new Set() });
ok(safeTarget && safeTarget.id === 'idle_rare', `skips stored+in-run Rare+, picks the idle one (got ${safeTarget && safeTarget.id})`);
const noneEligible = pickRecycleTarget(targetRoster.filter(c => c.id !== 'idle_rare'), { busyIds: new Set() });
ok(noneEligible === null, 'null when every Rare+ is stored or in-run (no valid XP recipient this tick)');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
