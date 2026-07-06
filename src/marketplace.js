import { isLuxCreature } from './breeding.js'; // lux shield for recycle + nursery priority ("make sure the pets are Lux")

// Marketplace client for Zenko (play.zolana.gg) — SELLER-side + read-only.
// Money-safety: this module can ONLY read and list/cancel. It never calls the buyer
// pay/quote path (/api/market/buy, /api/market/quote, /api/market/buy-gems) and never
// signs a Solana transaction. Listing is seller-passive: we POST metadata; $ZOLANA lands
// on the account wallet only when a human buyer pays. Endpoint contract reconned from the
// client bundle + confirmed by live probe (see NOTES.md "Marketplace API").
//
// Bot's act() FORBIDs /api/market/* through the generic path; this module is the narrow,
// explicit exception (same treatment as stamina/restore), calling client.api() directly and
// guarding every write through assertWriteAllowed().

const rnd = (a, b, r = Math.random) => a + r() * (b - a);
const lower = (value) => String(value ?? '').trim().toLowerCase();
const INACTIVE_LISTING_STATUSES = new Set([
  'sold', 'filled', 'complete', 'completed', 'cancelled', 'canceled',
  'expired', 'deleted', 'removed', 'inactive',
]);

function usdCeilCents(value) {
  if (!Number.isFinite(value)) return NaN;
  return Math.ceil((value * 100) - 1e-9) / 100;
}

// ── read parsing ────────────────────────────────────────────────────────────
export function parseListings(json) {
  const arr = json && json.listings;
  if (!Array.isArray(arr)) throw new Error('marketplace: unexpected listings shape');
  return arr.map((l) => ({
    id: l.id,
    itemId: l.item_id ?? l.itemId ?? null,
    itemKind: l.item_kind ?? l.itemKind,
    amount: Number(l.quantity ?? l.amount),
    priceUsd: Number(l.price_usd ?? l.priceUsd),
    priceGems: Number(l.price_gems ?? l.priceGems),
    currency: l.currency ?? 'zenko',
    seller: l.seller ?? l.seller_wallet ?? null,
    status: l.status ?? l.state ?? l.listing_status ?? l.listingStatus ?? null,
    listedAt: l.created_at ?? l.createdAt ?? l.listed_at ?? l.listedAt ?? l.updated_at ?? l.updatedAt ?? null,
    rarity: l.rarity ?? l.item?.rarity ?? null,
    element: l.element ?? l.item?.element ?? null,
  }));
}

function parseListingBrowseRows(raw) {
  if (Array.isArray(raw)) return parseListings({ listings: raw });
  return parseListings(raw);
}

function listingKind(row) {
  return lower(row?.itemKind ?? row?.item_kind ?? row?.kind);
}

function listingCurrency(row) {
  return lower(row?.currency || 'zenko');
}

export function isActiveListing(row) {
  if (!row) return false;
  const status = lower(row.status ?? row.state ?? row.listing_status ?? row.listingStatus);
  return !status || !INACTIVE_LISTING_STATUSES.has(status);
}

export function activeListingCount(rows = [], { itemKind = null, currency = null } = {}) {
  if (!Array.isArray(rows)) return 0;
  const kind = itemKind == null ? null : lower(itemKind);
  const cur = currency == null ? null : lower(currency);
  return rows.filter((row) => isActiveListing(row)
    && (kind == null || listingKind(row) === kind)
    && (cur == null || listingCurrency(row) === cur)).length;
}

export function chooseCashoutLane({ rng = Math.random, cfg = {} } = {}) {
  const lanes = [
    ['gold', Math.max(0, Number(cfg.cashoutGoldWeight ?? 1) || 0)],
    ['creature', Math.max(0, Number(cfg.cashoutCreatureWeight ?? 3) || 0)],
  ].filter(([, weight]) => weight > 0);
  const total = lanes.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) return null;
  let roll = Math.max(0, Math.min(1, Number(rng()))) * total;
  for (const [lane, weight] of lanes) {
    if (roll < weight) return lane;
    roll -= weight;
  }
  return lanes[lanes.length - 1][0];
}

function toWalletSet(fleetWallets) {
  if (fleetWallets instanceof Set) return fleetWallets;
  return new Set((fleetWallets || []).filter(Boolean).map((w) => String(w)));
}

// True if this listing belongs to one of our own fleet wallets — excluded from the
// "market" floor so our accounts price against the REAL external market and don't chase
// each other's listings down into a self-dump spiral.
function isFleetOwned(row, fleet) {
  if (!fleet.size) return false;
  const seller = row?.seller ?? row?.seller_wallet ?? null;
  return seller != null && fleet.has(String(seller));
}

// Floor price by RARITY, from real completed sales (recent-sales), in the $ZOLANA token.
// For each rarity we take the minimum price of recent deals (the real floor, not asks/listings).
// Returns { common: N_zolana, uncommon: …, rare: …, epic: …, legendary: …, mythical: … } —
// only the rarities that had sales. sales — array from parseSales(); price_usd → ZOLANA by
// dividing by the live token price. Our own fleet's sales are excluded (fleetWallets) — a "market" price.
const RARITY_KEYS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
export function parseSales(json) {
  const arr = Array.isArray(json?.sales) ? json.sales : Array.isArray(json) ? json : [];
  return arr.map((s) => ({
    itemKind: lower(s.item_kind ?? s.itemKind),
    priceUsd: Number(s.price_usd ?? s.priceUsd),
    currency: lower(s.currency ?? 'zenko'),
    rarity: lower(s.rarity ?? s.item?.rarity ?? ''),
    variant: lower(s.variant ?? s.item?.variant ?? ''),
    seller: s.seller ?? s.seller_wallet ?? null,
    soldAt: s.sold_at ?? s.soldAt ?? s.created_at ?? null,
  }));
}
export function creatureFloorZolanaByRarity(sales, { zolanaPriceUsd, fleetWallets } = {}) {
  const fleet = toWalletSet(fleetWallets);
  const price = Number(zolanaPriceUsd);
  const out = {};
  if (!(price > 0)) return out; // without a token price, conversion to ZOLANA is impossible
  for (const s of sales || []) {
    if (s.itemKind !== 'creature' || s.currency === 'gems') continue;
    if (!(s.priceUsd > 0) || !RARITY_KEYS.includes(s.rarity)) continue;
    if (s.seller != null && fleet.has(String(s.seller))) continue; // don't count our own sales
    // 2026-07-06: normal-variant only. A Golden/Shiny/Rainbow uncommon selling for $0.5 dragged the
    // "uncommon floor" from $0.02 up to $0.5 when there were no normal sales in the window (thin market)
    // — the dashboard candles jumped ×25 (owner: "Δ −96.1% in 4h"), and the bot listed OUR normal pets
    // at someone else's golden price. Special variants are priced separately anyway (CREATURE_VARIANT_PRICE_OVERRIDE_USD).
    if (s.variant && s.variant !== 'normal') continue;
    const zolana = s.priceUsd / price;
    if (out[s.rarity] == null || zolana < out[s.rarity]) out[s.rarity] = zolana;
  }
  return out;
}

// Count of REAL sales by rarity in the same recent-sales window (our own sales excluded, the same
// filter as creatureFloorZolanaByRarity) — feeds the candle chart's volume band (2026-07-06).
// The token price isn't needed: a counter, not a price.
export function salesCountByRarity(sales, { fleetWallets } = {}) {
  const fleet = toWalletSet(fleetWallets);
  const out = {};
  for (const s of sales || []) {
    if (s.itemKind !== 'creature' || s.currency === 'gems') continue;
    if (!(s.priceUsd > 0) || !RARITY_KEYS.includes(s.rarity)) continue;
    if (s.seller != null && fleet.has(String(s.seller))) continue;
    if (s.variant && s.variant !== 'normal') continue; // same variant filter as the floor — volume and price from one sample
    out[s.rarity] = (out[s.rarity] || 0) + 1;
  }
  return out;
}

// ── Demand pricing model (2026-07-06, owner: "we set prices people actually buy at, don't dump on each
// other, look at the overall economy"). Three market signals instead of a single min-floor:
//   clearing (the MEDIAN of real external sales) = "the price people actually buy at";
//   lowestAsk (min external ask in the book) = competition right now;
//   fleetAsk (min of OUR active asks) = a ladder against self-dumping: never undercut our own listing.
export function creatureClearingUsdByRarity(sales, { fleetWallets } = {}) {
  const fleet = toWalletSet(fleetWallets);
  const byRar = {};
  for (const s of sales || []) {
    if (s.itemKind !== 'creature' || s.currency === 'gems') continue;
    if (!(s.priceUsd > 0) || !RARITY_KEYS.includes(s.rarity)) continue;
    if (s.seller != null && fleet.has(String(s.seller))) continue;
    if (s.variant && s.variant !== 'normal') continue;
    (byRar[s.rarity] = byRar[s.rarity] || []).push(s.priceUsd);
  }
  const out = {};
  for (const [r, arr] of Object.entries(byRar)) {
    arr.sort((a, b) => a - b);
    const mid = arr.length >> 1;
    out[r] = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }
  return out;
}

// Min asks by rarity from browse: {external, fleet} — where the market stands and where we stand.
export function creatureAsksByRarity(rows, { fleetWallets } = {}) {
  const fleet = toWalletSet(fleetWallets);
  const out = {};
  for (const r of rows || []) {
    if (lower(r.itemKind) !== 'creature' || lower(r.currency || 'zenko') !== 'zenko') continue;
    if (!(r.priceUsd > 0)) continue;
    const rar = lower(r.rarity ?? '');
    if (!RARITY_KEYS.includes(rar)) continue;
    if (r.variant && lower(r.variant) !== 'normal') continue;
    const slot = out[rar] || (out[rar] = { external: null, fleet: null });
    const key = isFleetOwned(r, fleet) ? 'fleet' : 'external';
    if (slot[key] == null || r.priceUsd < slot[key]) slot[key] = r.priceUsd;
  }
  return out;
}

// Demand-based listing price. Base priority: clearing (they buy at it) → lowestAsk×(1−askUndercut)
// (no sales in the window — stand just below the cheapest external ask) → null (let the caller fall
// back to a seed). Ladder: never below our own active ask — raise the base up to it (queue behind our
// own lot, not undercut it). ±jitter → the fleet reads as independent sellers.
export function planDemandPrice({ clearingUsd, lowestAskUsd, fleetAskUsd, askUndercutPct = 0.05, jitterPct = 0.03, minPriceUsd = 0.01, rng = Math.random } = {}) {
  let base = null;
  if (clearingUsd > 0) base = clearingUsd;
  else if (lowestAskUsd > 0) base = lowestAskUsd * (1 - Math.max(0, Number(askUndercutPct) || 0));
  if (!(base > 0)) return null;
  if (fleetAskUsd > 0 && base < fleetAskUsd) base = fleetAskUsd; // anti-self-dump: don't undercut our own fleet
  const j = Math.max(0, Number(jitterPct) || 0);
  // floor-to-cent, not round: at $0.01-0.30 prices ordinary rounding eats the whole 5% undercut
  // (0.10×0.95=0.095 → round → back to 0.10, standing SIDE BY SIDE with the external ask instead of "just below")
  const priceUsd = Math.max(Number(minPriceUsd) || 0.01, Math.floor(base * (1 + (rng() * 2 - 1) * j) * 100) / 100);
  return { priceUsd, base, source: clearingUsd > 0 ? 'clearing' : 'ask' };
}

// Market pulse (2026-07-06, owner: "sell chaotically, at the pace the market needs — take the last
// 10-100 sales + their timestamps and decide"): absorption rate = external normal sales / the time
// interval they cover. From it the bot derives ITS OWN listing cooldown (see planListingPace) — hot
// market → list more often, dead → less; pouring into the book faster than it buys is pointless.
export function salesVelocityPerHour(sales, { fleetWallets, now = Date.now(), maxWindowMs = 24 * 3600 * 1000 } = {}) {
  const fleet = toWalletSet(fleetWallets);
  const ts = [];
  for (const s of sales || []) {
    if (s.itemKind !== 'creature' || s.currency === 'gems') continue;
    if (!(s.priceUsd > 0)) continue;
    if (s.seller != null && fleet.has(String(s.seller))) continue;
    if (s.variant && s.variant !== 'normal') continue;
    const t = Date.parse(s.soldAt || '');
    if (Number.isFinite(t) && t <= now && (now - t) <= maxWindowMs) ts.push(t);
  }
  if (ts.length < 2) return { perHour: 0, sampled: ts.length };
  ts.sort((a, b) => a - b);
  const spanH = Math.max((now - ts[0]) / 3600e3, 0.25); // window from the oldest sale to now, min 15m
  return { perHour: ts.length / spanH, sampled: ts.length };
}

// Cooldown for the next listing from the market pulse: for the fleet to occupy ~sharePct of the market,
// one of the seller accounts should list once every sellers/(velocity×share) hours. Chaos ±40% (owner:
// "chaotically"), clamped to [minMs..maxMs] — a dead market doesn't become eternal silence, a hot one doesn't become spam.
export function planListingPace({ perHour = 0, sellers = 1, sharePct = 0.4, minMs = 8 * 60e3, maxMs = 4 * 3600e3, rng = Math.random } = {}) {
  let baseMs;
  if (!(perHour > 0)) baseMs = maxMs; // no sales seen — the slowest pace, but not zero
  else baseMs = (Math.max(1, sellers) / (perHour * Math.max(0.05, sharePct))) * 3600e3;
  const jittered = baseMs * (0.6 + rng() * 0.8); // ±40%
  return Math.round(Math.min(Math.max(jittered, minMs), maxMs));
}

// Manual seed floor (USD) for rarities whose recent-sales window is often empty (thin market — traded
// less than Common/Uncommon). Without it, listJunkItem fell back to rarity-agnostic getMarketFloorUsd
// (min price among active lots of ANY creature rarity) — a Rare was really listed at the price of the
// cheapest Common/Uncommon on the market. Normal-variant (special variants — their own prices, see
// CREATURE_VARIANT_PRICE_OVERRIDE_USD below; the rest the owner prices manually). Used ONLY when the live
// per-rarity floor (from real sales) is unavailable for this rarity. A manual seed, not a measurement —
// update it against the actual market. 2026-07-06 (trader friend, the market kept falling): Uncommon $0.03, Rare $0.04.
export const CREATURE_FLOOR_SEED_USD = {
  uncommon: 0.03,
  rare: 0.04,
  // Epic $0.3 is known from the trader friend (2026-07-05) but NOT wired in: we HOLD Epic — don't sell
  // it until we've accumulated enough population to farm/breed (2026-07-06, owner). Wire it in when
  // Epic actually appears in junkCreatureRarities.
};

// Explicit prices for specific (rarity,variant) pairs — override BOTH the live per-rarity floor AND the
// general seed above. Needed separately because both the live floor (creatureFloorZolanaByRarity) and the
// general seed are variant-blind (average/estimate by rarity, not distinguishing Normal/Shiny/Golden/
// Rainbow), while a special variant is objectively worth more — reusing the rarity-floor would underprice
// it. 2026-07-06 (friend): uncommon rainbow — via the same breeding pipeline (vault → up to 8/8) — once
// exhausted, sell at $0.2 (Golden/Shadow and Rainbow of other rarities stay out of auto-sale — see junkVariantRarityOverrides).
export const CREATURE_VARIANT_PRICE_OVERRIDE_USD = {
  'uncommon:rainbow': 0.2,
};

// Creature floor (USD) for listing, accounting for RARITY (and, if a variant is given, more precisely):
// an explicit (rarity,variant) override wins over everything, otherwise the live floor (from
// creatureFloorZolanaByRarity, real sales, ZOLANA → USD at the current token price), otherwise the manual
// rarity-seed. null → no override, no live data, and no seed for this rarity → listJunkItem skips the
// listing (we don't guess).
export function creatureFloorUsdForRarity(rarity, floorZolanaByRarity, zolanaPriceUsd, variant = null) {
  const r = lower(rarity);
  if (variant != null) {
    const override = CREATURE_VARIANT_PRICE_OVERRIDE_USD[`${r}:${lower(variant)}`];
    if (override != null) return override;
  }
  const zolana = Number(floorZolanaByRarity?.[r]);
  const price = Number(zolanaPriceUsd);
  if (Number.isFinite(zolana) && zolana > 0 && Number.isFinite(price) && price > 0) return zolana * price;
  return CREATURE_FLOOR_SEED_USD[r] ?? null;
}

// Σ $ZOLANA floor value of a creature list at the given per-rarity floor map. unboundOnly:true
// counts ONLY sellable (unbound) creatures — bound ones (onboarding stock + bred offspring) can
// never be listed, so they are not realizable cash. Used for honest fleet valuation + Z/hour rate
// (the raw "count × floor" mark-to-market over-states cash: ~64% of the fleet is bound + no liquidity).
export function petFloorValueZolana(creatures = [], floorByRarity = {}, { unboundOnly = false } = {}) {
  let sum = 0;
  for (const c of creatures || []) {
    if (unboundOnly && isBound(c)) continue;
    const f = Number(floorByRarity?.[lower(c?.rarity)]);
    if (Number.isFinite(f) && f > 0) sum += f;
  }
  return sum;
}

// Organic market pricing: cluster a listing around the external floor with a small SYMMETRIC random
// jitter (±jitterPct), so a fleet of sellers reads as many independent hands at ~the same clear price
// — NOT a coordinated floor−ε undercut wall (which both looks like one seller and drives a self-dump
// spiral). Rounds to a cent, floors at minPriceUsd. Returns null when there's no external floor.
//
// Dump mode (2026-07-06, owner: "list 25-35% below floor, chaotically, to dump fast and unobtrusively"):
// undercutMin/Max > 0 → price = floor × (1 − uniform[min..max]) instead of clustering around the floor.
// Each listing draws its OWN random discount from the window (rng seeded per-account) — accounts read as
// independent sellers with different discount appetites, not a wall at one price. jitterPct is ignored in
// this mode (the discount window is wider than any jitter and already random).
export function planOrganicPrice({ floorUsd, jitterPct = 0, undercutMin = 0, undercutMax = 0, minPriceUsd = 0.01, rng = Math.random } = {}) {
  if (!(floorUsd > 0)) return null;
  const uMin = Math.max(0, Number(undercutMin) || 0);
  const uMax = Math.max(uMin, Number(undercutMax) || 0);
  let factor;
  if (uMax > 0) {
    factor = 1 - (uMin + rng() * (uMax - uMin));      // uniform in [1-max, 1-min] BELOW the floor
  } else {
    const j = Math.max(0, Number(jitterPct) || 0);
    factor = 1 + (rng() * 2 - 1) * j;                 // uniform in [1-j, 1+j] around the floor
  }
  const priceUsd = Math.max(Number(minPriceUsd) || 0.01, Math.round(floorUsd * factor * 100) / 100);
  return { priceUsd, jitterPct: Math.max(0, Number(jitterPct) || 0), undercutMin: uMin, undercutMax: uMax, floorUsd };
}

// Minimum per-unit USD among $ZOLANA-lane ('zenko') gold listings; null if none.
// Pass fleetWallets to price against the external market only (exclude our own listings).
export function goldFloorUsd(rows, { fleetWallets } = {}) {
  const fleet = toWalletSet(fleetWallets);
  const gold = rows.filter((r) => r.itemKind === 'gold' && r.currency !== 'gems'
    && r.amount > 0 && Number.isFinite(r.priceUsd) && r.priceUsd > 0
    && !isFleetOwned(r, fleet));
  if (!gold.length) return null;
  return Math.min(...gold.map((r) => r.priceUsd / r.amount));
}

// Minimum total USD among non-gem listings for a unique/fungible item kind.
export function marketFloorUsd(rows, { itemKind, currency = 'zenko', fleetWallets } = {}) {
  const kind = lower(itemKind);
  const fleet = toWalletSet(fleetWallets);
  const matches = rows.filter((r) => lower(r.itemKind) === kind
    && lower(r.currency || 'zenko') === lower(currency)
    && Number.isFinite(r.priceUsd) && r.priceUsd > 0
    && !isFleetOwned(r, fleet));
  if (!matches.length) return null;
  return Math.min(...matches.map((r) => r.priceUsd));
}

// ── completion + human-like sizing/pricing (pure) ────────────────────────────
export function isDoneScaling({ ceiling, ceilingStableTicks, cfg }) {
  const c = Number(ceiling) || 1;
  if (c >= cfg.cashoutDepthTarget) return true;
  return (Number(ceilingStableTicks) || 0) >= cfg.cashoutPlateauTicks;
}

// Plan one human-like Gold lot: a non-round partial chunk of surplus, priced with a small
// jitter around the live floor. Returns null when there's no floor or the lot is too small.
export function planGoldListing({ surplus, floorUsd, rng = Math.random, cfg }) {
  if (!(surplus > 0) || !(floorUsd > 0)) return null;
  const frac = rnd(cfg.cashoutChunkFracMin, cfg.cashoutChunkFracMax, rng);
  let quantity = Math.round(surplus * frac);
  if (quantity < cfg.cashoutMinLotGold) return null; // too small to bother / look normal
  if (quantity > surplus) quantity = surplus;
  // human: avoid round numbers — end in a 1..9 digit
  const nonRoundDigit = 1 + Math.floor(rnd(0, 9, rng));
  quantity = quantity - (quantity % 10) + nonRoundDigit;
  if (quantity > surplus) {
    const lowerNonRound = quantity - 10;
    quantity = lowerNonRound >= cfg.cashoutMinLotGold ? lowerNonRound : surplus;
  }
  if (quantity > surplus) quantity = surplus;
  const perUnit = Math.max(floorUsd, floorUsd * rnd(cfg.cashoutPriceJitterMin, cfg.cashoutPriceJitterMax, rng));
  const priceUsd = usdCeilCents(quantity * perUnit);
  if (priceUsd < cfg.cashoutMinPriceUsd) return null;
  return { quantity, priceUsd };
}

export function planUniqueFloorListing({ floorUsd, cfg }) {
  if (!(floorUsd > 0)) return null;
  const priceUsd = usdCeilCents(floorUsd);
  if (priceUsd < cfg.cashoutMinPriceUsd) return null;
  return { priceUsd };
}

function listingAgeMs(row, now) {
  const ts = Date.parse(row?.listedAt ?? row?.created_at ?? row?.createdAt ?? row?.listed_at ?? row?.listedAt ?? '');
  if (!Number.isFinite(ts)) return null;
  const n = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return Math.max(0, n - ts);
}

export function planListingReprice({ listing, floorUsd, now = Date.now(), cfg = {} } = {}) {
  if (!isActiveListing(listing) || listingCurrency(listing) !== 'zenko') return null;
  if (!(floorUsd > 0)) return null;

  const ageMs = listingAgeMs(listing, now);
  const minAgeMs = Math.max(0, Number(cfg.cashoutRepriceMinAgeMs ?? 4 * 60 * 60 * 1000) || 0);
  if (ageMs == null || ageMs < minAgeMs) return null;

  const currentPriceUsd = Number(listing?.priceUsd ?? listing?.price_usd);
  if (!(currentPriceUsd > 0)) return null;

  const kind = listingKind(listing);
  const amount = Number(listing?.amount ?? listing?.quantity) || 1;
  // Demand-decay (2026-07-06, owner: "prices people actually buy at"): a stale lot is the market saying
  // "nobody buys at this price". Step it down FROM THE CURRENT price (×(1−decay) per step, once per
  // cashoutRepriceMinAgeMs), rather than jumping to floor/discount-window — the price finds the demand
  // level on its own and doesn't punch through it. Without decay — old behavior (target = floor × undercut-mid).
  const decay = Math.max(0, Number(cfg.cashoutRepriceDecayPct) || 0);
  const uMin = Math.max(0, Number(cfg.cashoutUndercutPctMin) || 0);
  const uMax = Math.max(uMin, Number(cfg.cashoutUndercutPctMax) || 0);
  const undercutFactor = uMax > 0 ? 1 - (uMin + uMax) / 2 : 1;
  const targetRaw = kind === 'gold' ? amount * floorUsd
    : decay > 0 ? currentPriceUsd * (1 - decay)
    : floorUsd * undercutFactor;
  const newPriceUsd = usdCeilCents(targetRaw);
  const minPriceUsd = Math.max(0, Number(cfg.cashoutMinPriceUsd ?? 0.01) || 0);
  if (!(newPriceUsd >= minPriceUsd) || !(newPriceUsd < currentPriceUsd)) return null;

  const dropPct = (currentPriceUsd - newPriceUsd) / currentPriceUsd;
  const minDropPct = Math.max(0, Number(cfg.cashoutRepriceMinDropPct ?? 0.05) || 0);
  if (dropPct < minDropPct) return null;

  return {
    listingId: listing.id,
    itemKind: kind,
    itemId: listing.itemId ?? listing.item_id ?? null,
    quantity: kind === 'gold' ? amount : 1,
    oldPriceUsd: currentPriceUsd,
    newPriceUsd,
    dropPct,
    ageMs,
  };
}

function isListed(item) {
  return Boolean(item?.listed || item?.listing_id || item?.listingId || item?.market_listing_id || item?.marketListingId);
}

function isBound(item) {
  return Boolean(item?.bound || item?.is_bound || item?.isBound || item?.soulbound || item?.soul_bound || item?.tradeable === false);
}

function isFavoriteCreature(creature) {
  return Boolean(creature?.favorite || creature?.is_favorite || creature?.isFavorite);
}

function hasBusyStatus(item) {
  const status = lower(item?.status);
  return status === 'busy' || status.includes('dungeon') || status === 'listed';
}

// A pet is physically on a run if it has a run_id set (or is staked) — the server rejects a sacrifice
// of such a pet with 409 "out on a run". busyIds/status don't always catch this (e.g. the run is already
// ready but not yet claimed), so we check the field directly.
export function isInRun(creature) {
  return creature?.run_id != null || creature?.runId != null
    || creature?.stored === true || lower(creature?.status) === 'in a dungeon';
}

function isEquippedRelic(relic) {
  return relic?.equipped === true || relic?.equipped_on != null || relic?.equippedOn != null
    || relic?.equip_slot != null || relic?.equipSlot != null || relic?.creature_id != null || relic?.creatureId != null;
}

function relicKey(relic) {
  return [
    lower(relic?.rarity || 'unknown'),
    lower(relic?.stat || relic?.stat_bonus || relic?.statBonus || relic?.affix || relic?.slot || relic?.class || relic?.name || 'unknown'),
  ].join(':');
}

function relicScore(relic) {
  const direct = Number(relic?.value ?? relic?.roll ?? relic?.amount ?? relic?.bonus ?? relic?.stat_value ?? relic?.statValue);
  if (Number.isFinite(direct)) return direct;
  if (Array.isArray(relic?.affixes)) {
    return relic.affixes.reduce((sum, affix) => sum + (Number(affix?.value ?? affix?.amount) || 0), 0);
  }
  return 0;
}

export function pickJunkRelics(relics = [], cfg = {}) {
  const allowed = new Set((cfg.junkRelicRarities || ['common']).map(lower));
  const keepPerKey = Math.max(0, Number(cfg.junkRelicKeepPerKey ?? 2));
  const groups = new Map();
  for (const relic of relics || []) {
    if (!allowed.has(lower(relic?.rarity))) continue;
    if (isListed(relic) || isBound(relic) || hasBusyStatus(relic) || isEquippedRelic(relic)) continue;
    const key = relicKey(relic);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(relic);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (relicScore(b) - relicScore(a)) || String(a.id || '').localeCompare(String(b.id || '')));
    out.push(...group.slice(keepPerKey));
  }
  return out;
}

const STAGE_RANK = { baby: 0, juvenile: 1, adult: 2, elder: 3 };

function isPlacedCreature(creature) {
  return creature?.placed === true || creature?.plot_x != null || creature?.plotX != null
    || creature?.plot_y != null || creature?.plotY != null;
}

function creatureScore(creature) {
  return ((STAGE_RANK[lower(creature?.stage)] ?? -1) * 100000)
    + ((Number(creature?.level) || 0) * 1000)
    + (Number(creature?.xp) || 0);
}

export function pickJunkCreatures(creatures = [], cfg = {}) {
  const allowedRarities = new Set((cfg.junkCreatureRarities || ['common']).map(lower));
  const allowedStages = new Set((cfg.junkCreatureStages || ['Baby', 'Juvenile']).map(lower));
  const allowedVariants = new Set((cfg.junkCreatureVariants || ['normal', '']).map(lower));
  // 2026-07-06 (friend: "uncommon rainbow — into the vault, and sell at 0.2 on the market"): targeted
  // exceptions ON TOP of the general junkCreatureVariants — a specific (rarity,variant) pair is sellable
  // even if the variant in general isn't in allowedVariants. Format 'rarity:variant', lowercase. Golden/
  // Shadow and Rainbow of OTHER rarities stay out of auto-sale until explicitly added here too.
  const variantOverrides = new Set((cfg.junkVariantRarityOverrides || []).map(lower));
  const keepPerSpecies = Math.max(0, Number(cfg.junkCreatureKeepPerSpecies ?? 2));
  // 2026-07-06: without this gate, selling and breeding pull from one pool without coordination — a
  // creature could go to market BEFORE using up all its breed attempts, cutting the Uncommon→Rare→Epic
  // upgrade short. 0 (default) = gate off (old behavior). The farm profile sets 8 = breedMaxCount (sell
  // only the exhausted). Common isn't bred, its breed_count is always 0 — the gate doesn't affect it.
  const minBreedCount = Math.max(0, Number(cfg.junkMinBreedCount) || 0);
  // 2026-07-06 (night: sellable stock = 1 pet across the fleet, sales stalled): surplus beyond the top-N
  // of one (species,rarity) sells IMMEDIATELY, without waiting for 8/8 — we keep keep-N (2 pairs) as
  // breeding stock and dump the weakest duplicates beyond it. null/0 = off (old behavior: exhausted only).
  const surplusKeep = Math.max(0, Number(cfg.junkSurplusKeepPerSpecies) || 0);
  const surplusOk = new Set();
  if (surplusKeep > 0) {
    const bySpecRar = new Map();
    for (const c of creatures || []) {
      if ((Number(c?.breed_count) || 0) >= 8) continue; // the exhausted don't count as breeding stock
      const k = `${lower(c?.species || c?.creature_id)}:${lower(c?.rarity)}`;
      if (!bySpecRar.has(k)) bySpecRar.set(k, []);
      bySpecRar.get(k).push(c);
    }
    for (const group of bySpecRar.values()) {
      if (group.length <= surplusKeep) continue;
      group.sort((a, b) => rareplusValue(b) - rareplusValue(a));
      for (const c of group.slice(surplusKeep)) surplusOk.add(c.id); // the weakest beyond keep-N
    }
  }
  const busyIds = cfg.busyIds instanceof Set ? cfg.busyIds : new Set(cfg.busyIds || []);
  const groups = new Map();
  for (const creature of creatures || []) {
    // don't sell lux at all while in the accumulation phase (3 pets across the fleet) — it's strategic
    // ladder stock Gleamguard→Luminara→Solarknight, not merchandise. junkProtectLux:false returns it to sale.
    if (cfg.junkProtectLux !== false && isLuxCreature(creature)) continue;
    if (!allowedRarities.has(lower(creature?.rarity))) continue;
    if (!allowedStages.has(lower(creature?.stage))) continue;
    const variantLower = lower(creature?.variant || 'normal');
    const rarityVariantKey = `${lower(creature?.rarity)}:${variantLower}`;
    if (!allowedVariants.has(variantLower) && !variantOverrides.has(rarityVariantKey)) continue;
    if (minBreedCount > 0 && (Number(creature?.breed_count) || 0) < minBreedCount && !surplusOk.has(creature?.id)) continue;
    if (busyIds.has(creature?.id) || isInRun(creature) || isFavoriteCreature(creature) || isListed(creature) || isBound(creature) || hasBusyStatus(creature) || isPlacedCreature(creature)) continue;
    const key = lower(creature?.species || creature?.creature_id || creature?.creatureId || 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(creature);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (creatureScore(b) - creatureScore(a)) || String(a.id || '').localeCompare(String(b.id || '')));
    out.push(...group.slice(keepPerSpecies).sort((a, b) => (creatureScore(a) - creatureScore(b)) || String(a.id || '').localeCompare(String(b.id || ''))));
  }
  return out;
}

// ── recycle (sacrifice → XP) selection — DESTRUCTIVE; callers MUST guard behind opt-in ──
const KEEP_RARITIES = new Set(['rare', 'epic', 'legendary', 'mythical']);
export function isSpecialVariant(variant) {
  const v = lower(variant);
  return !!v && v !== 'normal';
}
// Variants PROTECTED from recycle/unplace-into-XP regardless of rarity: Golden/Shadow/Rainbow.
// Shiny is NOT protected (owner 2026-07-05): "shiny commons → into XP too, shiny uncommons — like normal
// uncommons" — Shiny Common/Uncommon go into fodder/breeding stock on par with Normal. Golden/Shadow/
// Rainbow stay out of reach of sacrifice at any rarity in the fodder set (Common/Uncommon). Rare+ is out
// of the fodder set by rarity anyway — this predicate doesn't touch it regardless of variant.
const PROTECTED_VARIANTS = new Set(['golden', 'shadow', 'rainbow']);
export function isProtectedVariant(variant) {
  return PROTECTED_VARIANTS.has(lower(variant));
}
// Fodder for recycling into XP = common/uncommon of the normal variant, not in a run, not placed, not
// favorited, not listed. BOUND creatures are INCLUDED in fodder DELIBERATELY: a sacrifice is
// self-consuming your own pet for XP, NOT a trade, so bound (which only blocks a marketplace SALE)
// doesn't apply to it — see NOTES /api/creature/sacrifice.
// ⚠️ Wrongly excluding bound here froze the WHOLE farm's XP funnel: ~96% of Common on live accounts is
// bound (onboarding stock ~20 + bred offspring of bound parents), and they NEVER reached fodder → "no
// free Common" → party_power stalls → dungeon depth collapses.
// (bound is still excluded from the SALE in pickJunkCreatures — there it's correct.)
// Golden/Shadow/Rainbow are NEVER sacrificed; Shiny is sacrificed like Normal (see isProtectedVariant).

export function pickRecycleFodder(creatures = [], cfg = {}) {
  const fodderRarities = new Set((cfg.recycleFodderRarities || ['common', 'uncommon']).map(lower)); // always-fodder
  // Rarities that become fodder ONLY once they've exhausted the lifetime breed cap (breed_count ≥ cap):
  // the friend's strategy — an Uncommon that used up its 8 breeds goes to XP rather than sitting as
  // ballast in the roster. Non-exhausted Uncommon (breeding stock) stay. Rare/Epic aren't included here
  // (we hold them for sale once the wallet matures).
  const exhaustRarities = new Set((cfg.recycleExhaustedRarities || []).map(lower));
  const cap = Number(cfg.breedMaxCount ?? 8);
  const busyIds = cfg.busyIds instanceof Set ? cfg.busyIds : new Set(cfg.busyIds || []);
  const protectSpecial = cfg.recycleProtectSpecialVariants !== false; // default: protect Golden/Shadow/Rainbow (not Shiny)
  const out = [];
  for (const c of creatures || []) {
    const rar = lower(c?.rarity);
    const always = fodderRarities.has(rar);
    const exhausted = exhaustRarities.has(rar) && (Number(c?.breed_count) || 0) >= cap; // an exhausted breeder
    if (!always && !exhausted) continue;
    if (protectSpecial && isProtectedVariant(c?.variant)) continue;    // don't sacrifice Golden/Shadow/Rainbow; Shiny = like Normal
    if (cfg.recycleProtectLux !== false && isLuxCreature(c)) continue; // lux commons = breeding stock for T1 (Gleamguard), not XP fodder
    if (busyIds.has(c?.id) || isInRun(c) || isFavoriteCreature(c) || isPlacedCreature(c) || isListed(c) || hasBusyStatus(c)) continue; // isInRun: run_id → otherwise 409 "out on a run"; bound NOT excluded (see comment)
    out.push(c);
  }
  return out;
}
// Placed fodder = creatures of a fodder rarity PARKED on island plots (place-auto puts them there) that
// must be UNPLACED (unplace) to become available for sacrifice. Same rules as pickRecycleFodder (common
// always; uncommon if exhausted 8/8; not a special variant/favorite/listed/in a run), but requiring
// placed=true. Bug: without unplace, parked commons NEVER go into XP (isPlacedCreature excludes them from
// fodder), ~61 commons across the fleet got stuck this way forever.
export function pickPlacedFodder(creatures = [], cfg = {}) {
  const fodderRarities = new Set((cfg.recycleFodderRarities || ['common', 'uncommon']).map(lower));
  const exhaustRarities = new Set((cfg.recycleExhaustedRarities || []).map(lower));
  const cap = Number(cfg.breedMaxCount ?? 8);
  const protectSpecial = cfg.recycleProtectSpecialVariants !== false;
  const out = [];
  for (const c of creatures || []) {
    const rar = lower(c?.rarity);
    const always = fodderRarities.has(rar);
    const exhausted = exhaustRarities.has(rar) && (Number(c?.breed_count) || 0) >= cap;
    if (!always && !exhausted) continue;
    if (protectSpecial && isProtectedVariant(c?.variant)) continue; // Golden/Shadow/Rainbow protected; Shiny = like Normal
    if (cfg.recycleProtectLux !== false && isLuxCreature(c)) continue; // lux — the same shield as in pickRecycleFodder
    if (isFavoriteCreature(c) || isListed(c) || isInRun(c)) continue; // in a run → not "just on a plot", don't touch
    if (!isPlacedCreature(c)) continue;                                // only the parked (stuck) ones
    out.push(c);
  }
  return out;
}

// Target = the strongest Rare+ pet (by stage/level) — it receives XP from the sacrifices. Special Common
// variants are protected from fodder separately, but don't serve as an XP target (we don't pump Common).
// If there are NO Rare+ keepers — return null: don't recycle until a Rare appears (otherwise XP pours into
// a Common we'd then recycle ourselves, and the account strips down to zero runners).
// Exclude stored (in the Vault) and busy (run_id/in a run): the caller (handleRecycle/handleVault) already
// passes busyIds, but it used to be ignored — the target could end up a vaulted/busy pet (found on the
// vault audit 2026-07-05).
export function pickRecycleTarget(creatures = [], cfg = {}) {
  const busyIds = cfg.busyIds instanceof Set ? cfg.busyIds : new Set(cfg.busyIds || []);
  const keepers = (creatures || []).filter(c => KEEP_RARITIES.has(lower(c?.rarity)) && !isBound(c) && !isInRun(c) && !busyIds.has(c?.id));
  let best = null;
  for (const c of keepers) if (!best || creatureScore(c) > creatureScore(best)) best = c;
  return best;
}

// Vault candidate — "rares into the vault", BUT only as a pressure valve when the roster is full
// (otherwise vaulting removes a pet from dungeon rotation = fewer parallel runs = less gold). Returns the
// least valuable FREE Rare+ (by rarity→stage→level ascending) to free a slot with minimal throughput loss
// while keeping the pet in storage (not sold, not burned). The strongest Rare+ (dungeon runners) and the
// recycle target are NOT touched. null → no one is safe to vault.
// Rare+ value by rarity→stage→level (a shared scale for pickVaultCandidate AND planVaultSwap — both sides
// of a swap/eviction must be compared with ONE ruler, or the decisions will be inconsistent).
export function rareplusValue(c) {
  return (RARITY_KEYS.indexOf(lower(c?.rarity)) + 1) * 1e6 + ((STAGE_RANK[lower(c?.stage)] ?? 0) * 1e3) + (Number(c?.level) || 0);
}

export function pickVaultCandidate(creatures = [], cfg = {}, { busyIds, protectId } = {}) {
  const busy = busyIds instanceof Set ? busyIds : new Set(busyIds || []);
  const keepStrongest = Math.max(0, Number(cfg.vaultKeepStrongestRareplus ?? 0));
  const pool = [];
  for (const c of creatures || []) {
    if (!KEEP_RARITIES.has(lower(c?.rarity))) continue;                 // Rare+ only ("rares into the vault")
    if (c?.id === protectId) continue;                                   // not the recycle target (strongest Rare+)
    if (busy.has(c?.id) || isInRun(c) || isFavoriteCreature(c) || isListed(c) || c?.stored === true) continue;
    pool.push(c);
  }
  if (!pool.length) return null;
  // sort DESCENDING by value, cut off the keepStrongest best (they run dungeons), from the rest vault the
  // least valuable (min throughput loss, the pet is preserved in storage).
  pool.sort((a, b) => rareplusValue(b) - rareplusValue(a));
  const vaultable = pool.slice(keepStrongest);
  if (!vaultable.length) return null;
  return vaultable[vaultable.length - 1]; // the least valuable among those not in the "strongest"
}

// Fleet↔vault swap: pickVaultCandidate is a one-shot valve (it hides under pressure and forgets forever,
// there's no "un-vault" path). Because of that the vault accumulates upgrades over time (bred-up / grown
// Rare+) that NEVER return to battle while weak freshly-hatched youngsters occupy a runner's slot. If the
// strongest vaulted pet is MORE VALUABLE than the weakest active runner by a meaningful margin
// (vaultSwapMinValueMargin, a filter against noisy/thrashy swaps at near-equal value) — swap them. Both
// Rare+ (the same KEEP_RARITIES scope as vault), compared by the shared rareplusValue. null → nothing to swap / no reason to.
export function planVaultSwap(creatures = [], cfg = {}, { busyIds, protectId } = {}) {
  const busy = busyIds instanceof Set ? busyIds : new Set(busyIds || []);
  const minMargin = Math.max(0, Number(cfg.vaultSwapMinValueMargin ?? 1000));
  const activePool = [];
  const storedPool = [];
  for (const c of creatures || []) {
    if (!KEEP_RARITIES.has(lower(c?.rarity))) continue; // swap — Rare+ only, like vault
    if (c?.id === protectId) continue;                   // don't touch the recycle target (strongest Rare+)
    if (isFavoriteCreature(c) || isListed(c)) continue;
    if (c?.stored === true) {
      // 2026-07-06: the vault is a nursery. Live breeding stock (breed_count<8, a breed-pool rarity) is
      // NOT a candidate to return to dungeons — otherwise swap yanked a strong epic out of the nursery
      // right after intake (a strong stored > the weakest active always) and epic-pair breeding never started.
      const breedRarities = new Set((cfg.vaultBreedingRarities || []).map(lower));
      if (breedRarities.has(lower(c?.rarity)) && (Number(c?.breed_count) || 0) < 8) continue;
      storedPool.push(c); continue;
    }
    if (busy.has(c?.id) || isInRun(c)) continue;          // the eviction candidate must be free
    activePool.push(c);
  }
  if (!activePool.length || !storedPool.length) return null;
  let weakestActive = activePool[0];
  for (const c of activePool) if (rareplusValue(c) < rareplusValue(weakestActive)) weakestActive = c;
  let strongestStored = storedPool[0];
  for (const c of storedPool) if (rareplusValue(c) > rareplusValue(strongestStored)) strongestStored = c;
  if (rareplusValue(strongestStored) - rareplusValue(weakestActive) < minMargin) return null;
  return { evict: weakestActive, admit: strongestStored };
}

// Intake into the vault FOR BREEDING (2026-07-06, owner: "let them breed, but in the vault, they need to
// be moved around"): a rarity pool separate from pickVaultCandidate — that one is historically Rare+-only
// (KEEP_RARITIES), while the bottom-up start strategy is specifically from Uncommon. Take active
// (non-vaulted) Adult+ with breeds left (breed_count < 8 — the exhausted have nothing to do in the vault,
// they go straight to sale via pickBreedingGraduate below), keep the top-N strongest as runners (the same
// logic as pickVaultCandidate), and from the rest admit the least valuable — they can spare a runner's
// slot for a free breed.
export function pickBreedingIntake(creatures = [], cfg = {}, { busyIds } = {}) {
  const busy = busyIds instanceof Set ? busyIds : new Set(busyIds || []);
  const rarities = new Set((cfg.vaultBreedingRarities || ['uncommon', 'rare']).map(lower));
  // SEPARATE from vaultKeepStrongestRareplus (that's about Rare+ dungeon runners; here the pool is already
  // narrowed to Uncommon/Rare for breeding, where a "top-6" would eat the whole small pool and intake would never fire).
  const keepStrongest = Math.max(0, Number(cfg.vaultBreedingKeepStrongest ?? 0));
  const pool = [];
  for (const c of creatures || []) {
    // lux species enter the nursery at ANY rarity (including Common — glimra/lumen are breeding stock for
    // T1, see LUX_SPECIES in breeding.js); the rest by vaultBreedingRarities as before.
    const lux = isLuxCreature(c);
    if (!lux && !rarities.has(lower(c?.rarity))) continue;
    if (c?.stored === true) continue;                                    // already in the vault
    if ((Number(c?.breed_count) || 0) >= 8) continue;                    // exhausted — not here, but to sale
    // 2026-07-06: the Adult+ and !isBound gates are REMOVED (owner: "breed everyone, from vault and fleet").
    // The vault is a nursery: feeding/evolution walk allCreatures, a Baby matures IN the vault without
    // taking a roster slot (a 50/50 roster choked hatch while youngsters matured outside — ready eggs held
    // the incubator for hours). Bound is parked too: it breeds on par with the rest (offspring → XP funnel),
    // and it can't be sold anyway — it has nothing to do on the active roster.
    if (busy.has(c?.id) || isInRun(c) || isFavoriteCreature(c) || isListed(c)) continue;
    pool.push(c);
  }
  if (!pool.length) return null;
  const luxPool = pool.filter(isLuxCreature);
  if (luxPool.length) return luxPool[0]; // priority: any free lux straight into the nursery, keepStrongest doesn't cut it
  // 2026-07-06 (a night without a single epic breed despite live thornmaw pairs on 5 accounts): "least
  // valuable first" meant "forever uncommon" — epic/rare never reached the nursery and flew off to dungeons
  // every tick. Now: whoever HAS a same-species+rarity partner (a second potential parent on the account,
  // not exhausted) ranks higher (a pair = an egg of the next rarity), then HIGHER rarity first (the ladder
  // up matters more than uncommon volume), and within that, least valuable (spare the strongest runners).
  const pairKey = (c) => `${lower(c?.species || c?.creature_id)}:${lower(c?.rarity)}`;
  const kin = new Map(); // key -> how many potential parents of this (species,rarity) on the account total
  for (const c of creatures || []) {
    if ((Number(c?.breed_count) || 0) >= 8) continue;
    const k = pairKey(c);
    kin.set(k, (kin.get(k) || 0) + 1);
  }
  const hasPair = (c) => (kin.get(pairKey(c)) || 0) >= 2;
  pool.sort((a, b) =>
    (Number(hasPair(b)) - Number(hasPair(a)))
    || RARITY_KEYS.indexOf(lower(b?.rarity)) - RARITY_KEYS.indexOf(lower(a?.rarity))
    || rareplusValue(a) - rareplusValue(b));
  const intakeable = pool.slice(0, Math.max(1, pool.length - keepStrongest));
  return intakeable[0] || null;
}

// Exit from the vault on breed exhaustion: as soon as a "for-breeding" vaulted pet reaches
// breed_count>=8, withdraw it (store:false) — otherwise pickJunkCreatures never sees it (isInRun treats
// stored as busy). One per pass — consistent with the rest of the throttling (vault/recycle).
export function pickBreedingGraduate(creatures = [], cfg = {}) {
  const rarities = new Set((cfg.vaultBreedingRarities || ['uncommon', 'rare']).map(lower));
  for (const c of creatures || []) {
    if (c?.stored !== true) continue;
    if (!rarities.has(lower(c?.rarity))) continue;
    if ((Number(c?.breed_count) || 0) < 8) continue;
    return c;
  }
  return null;
}

// Sales whose id we haven't ledgered yet.
export function newlySold(prevIds, sales = []) {
  const prev = prevIds instanceof Set ? prevIds : new Set(prevIds || []);
  return (Array.isArray(sales) ? sales : []).filter((s) => s && s.id && !prev.has(s.id));
}

// ── write guard + seller-passive actions ─────────────────────────────────────
export const MARKET_WRITE_WHITELIST = new Set(['/api/market/list', '/api/market/cancel']);

export function assertWriteAllowed(path) {
  if (!MARKET_WRITE_WHITELIST.has(path)) {
    throw new Error(`marketplace: refusing forbidden write path ${path}`);
  }
  return path;
}

// POST a Gold listing. No signature, moves no funds. $ZOLANA arrives later on a buyer fill.
export async function listGold(client, { quantity, priceUsd }) {
  if (!(quantity > 0) || !(priceUsd >= 0.01)) throw new Error('marketplace: bad gold listing args');
  const path = assertWriteAllowed('/api/market/list');
  return client.api(path, { itemKind: 'gold', resource: null, quantity, currency: 'zenko', priceUsd });
}

export async function listMarketItem(client, { itemKind, itemId, priceUsd }) {
  if (!itemKind || !itemId || !(priceUsd >= 0.01)) throw new Error('marketplace: bad item listing args');
  const path = assertWriteAllowed('/api/market/list');
  return client.api(path, { itemKind, itemId, currency: 'zenko', priceUsd });
}

export async function cancelListing(client, listingId) {
  const path = assertWriteAllowed('/api/market/cancel');
  return client.api(path, { listingId });
}

// read-only GETs (client.api(path) with no body ⇒ GET)
export async function getGoldFloorUsd(client, { fleetWallets } = {}) {
  const raw = await client.api('/api/market/browse?kind=gold');
  return goldFloorUsd(parseListings(raw), { fleetWallets });
}

// Creature floor by rarity in $ZOLANA, from real recent market sales.
export async function getCreatureFloorZolanaByRarity(client, { zolanaPriceUsd, fleetWallets, limit = 200 } = {}) {
  const raw = await client.api(`/api/market/recent-sales?kind=creature&limit=${limit}`);
  return creatureFloorZolanaByRarity(parseSales(raw), { zolanaPriceUsd, fleetWallets });
}

// Like getCreatureFloorZolanaByRarity, but returns BOTH the floor AND the sale count per rarity in one
// request (2026-07-06, for the history/candle chart — see market-history.js appendFloorSnapshot). Not a
// second network call on top of the existing one — the same recent-sales, just both computations from one raw dataset.
export async function getCreatureFloorAndVolumeByRarity(client, { zolanaPriceUsd, fleetWallets, limit = 200 } = {}) {
  const raw = await client.api(`/api/market/recent-sales?kind=creature&limit=${limit}`);
  const sales = parseSales(raw);
  return {
    floors: creatureFloorZolanaByRarity(sales, { zolanaPriceUsd, fleetWallets }),
    counts: salesCountByRarity(sales, { fleetWallets }),
    clearingUsd: creatureClearingUsdByRarity(sales, { fleetWallets }), // median of real sales — the demand-price base
    velocity: salesVelocityPerHour(sales, { fleetWallets }),           // market pulse — the adaptive listing pace
  };
}

export async function getMarketFloorUsd(client, itemKind, { fleetWallets } = {}) {
  const raw = await client.api(`/api/market/browse?kind=${encodeURIComponent(itemKind)}`);
  return marketFloorUsd(parseListings(raw), { itemKind, fleetWallets });
}

export async function getMyListings(client, { itemKind = null } = {}) {
  const params = new URLSearchParams({ mine: '1' });
  if (itemKind) params.set('kind', itemKind);
  const raw = await client.api(`/api/market/browse?${params.toString()}`);
  return parseListingBrowseRows(raw);
}

export async function getMyGoldListings(client) {
  return (await getMyListings(client, { itemKind: 'gold' }))
    .filter((row) => listingKind(row) === 'gold');
}

export async function getMyGoldSales(client, limit = 100) {
  const raw = await client.api(`/api/market/my-sales?limit=${limit}`);
  const arr = Array.isArray(raw?.sales) ? raw.sales : Array.isArray(raw) ? raw : [];
  return arr.filter((s) => (s.item_kind ?? s.itemKind) === 'gold');
}

// All own sales (gold + creatures + relics + …) so every marketplace fill is ledgerable.
export async function getMySales(client, limit = 100) {
  const raw = await client.api(`/api/market/my-sales?limit=${limit}`);
  return Array.isArray(raw?.sales) ? raw.sales : Array.isArray(raw) ? raw : [];
}

// Pure: map one sold listing → ledger amounts. Gold carries a gold delta (fungible balance
// left the account); unique items (creature/relic/…) only credit $ZOLANA. $ZOLANA is derived
// from the sale's USD price and the account's live token price.
export function saleLedgerAmounts(sale, zolanaPriceUsd) {
  const usd = Number(sale?.price_usd ?? sale?.priceUsd ?? 0);
  const kind = sale?.item_kind ?? sale?.itemKind ?? 'item';
  const zolana = zolanaPriceUsd ? usd / zolanaPriceUsd : 0;
  const buyer = sale?.buyer ?? sale?.buyer_wallet ?? sale?.buyerWallet ?? null;
  const amounts = { zolana };
  if (kind === 'gold') amounts.gold = -(Number(sale?.quantity) || 0);
  return { amounts, usd, kind, buyer };
}
