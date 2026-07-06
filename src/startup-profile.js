import { seededRandom } from './jitter.js';
import { DEFAULT_REGISTRY_PATH, loadRegistry } from './account-creator.js';

// Addresses of all our fleet wallets — excluded from the market floor calculation so accounts don't
// chase each other's listings down (self-dump). Read the registry once and cache it.
let _fleetWalletsCache = null;
export function fleetWalletAddresses(registryPath = DEFAULT_REGISTRY_PATH) {
  if (_fleetWalletsCache) return _fleetWalletsCache;
  try {
    const accounts = loadRegistry(registryPath).accounts || [];
    _fleetWalletsCache = accounts.map((a) => a.address).filter(Boolean);
  } catch {
    _fleetWalletsCache = [];
  }
  return _fleetWalletsCache;
}

export function farmTradingConfig(overrides = {}) {
  return {
    shuffleSafeActions: true,
    // 2026-07-06 (owner, FINAL, on top of the same day's lux experiment): "need to fully turn it off so
    // it doesn't buy eggs" — buying is turned OFF COMPLETELY, including lux. The roster is already at the
    // cap of 50 and chokes hatch/incubator; growth comes ONLY from breeding (the vault nursery below) +
    // dungeon drops. The lux-buying mechanism (elementalEggTypes/eggBuyDailyCap) stays in the code,
    // disabled — re-enabling is one line.
    autoBuyEggs: false,
    // New-account bootstrap (2026-07-06, owner: "for new accounts, buy 6 eggs at 50k, and later just breed
    // on cooldown"): a fresh account has nothing to breed, so it buys a one-time batch of 6 × 50k elemental
    // eggs to seed breeding stock, then breeds only (autoBreed). Auto-gated to new accounts
    // (roster < bootstrapRosterMax), so established accounts (roster ~50) are untouched; autoBuyEggs stays
    // OFF (no ongoing buying). See handleEggs. This is the ONLY egg buying that happens now.
    bootstrapEggBuy: true,
    bootstrapEggCount: 6,
    bootstrapRosterMax: 12,
    bootstrapEggTypes: ['forest', 'ocean', 'mountain', 'volcano', 'sky'], // 50k elemental eggs (20% Rare), rotated for species variety
    autoBuyStamina: true,
    feed: true,                          // feed Baby/Juv→Adult (stage-gated in handleFeeding): accumulates creature_xp → handleEvolve(useXp) skips the maturation timer → party_power↑ (stage) + Adult stock for breeding. Don't feed Adult/Elder.
    feedMaxPerTick: 10,                  // 2026-07-06: breeding stock of Babies matures via feeds (Baby→Juv 5 feeds, Juv→Adult 13, cooldown 11m/pet); after an egg burst accounts have 30+ Babies — the default cap of 3 choked the conveyor (~2.2 feeds/min when ~3.3 was needed), 10 per tick covers 36+ youngsters
    autoBreed: true,                     // tier-climb breeder (planBreedPair): same-species Adult+ pairs with gates (breed_count<8, cooldown 25m, happiness≥50, rarity≤epic) → climb the tier. Bound offspring is now recycled into XP (the funnel fix).
    breedGoldReserve: 5000,              // Gold reserve for breeding: a bit above minGoldReserve so we don't drain to zero. The egg↔breed KNOB: higher → prioritize 50k eggs, lower → prioritize breeding (cheaper per rarity). Eggs are queue-capped (4), so breeding can lead.
    breedMinRarity: 'uncommon',          // friend's strategy: start at Uncommon (Common → XP fodder, don't breed). Order bottom-up: uncommon→rare→epic.
    breedAllowCrossSpecies: false,       // 2026-07-06 (friend): "one species, one rarity, one tier, for both" — strictly same-species, not just same-rarity. Matches the base default, fixed here as a deliberate decision.
    // Evolution caps at Adult except Legendary/Mythical (2026-07-06, friend: "don't push uncommon/rare/epic to
    // Elder — Elder just wastes Gold; only leggies are worth leveling to Elder; the rest stay Adult and breed
    // from the vault"). Adult is the breeding stage, so stopping there feeds the conveyor and saves Gold.
    evolveElderRarities: ['legendary', 'mythical'],
    autoForgeTrainerRelic: true,         // Task-2 (friend): forge trainer relics → pets born 2× faster. forgeMinGold=400k protects the egg/breed budget (right now no account holds that much → the forge sleeps until they get rich). ⚠️ craft/equip params unconfirmed — money-safe (a wrong relicClass → 400 without spending gold); verify the first live forge.
    relicMaxActionsPerTick: 15,          // 2026-07-06: batch cap on relic equip/unequip per call, so a big one-off backlog doesn't eat the whole tick on human pauses and block dispatchRuns/dungeons — it's spread over several cycles (10 min throttle) interleaved with farming
    forgeMinGold: 400000,                // forge only at gold ≥ 400k (forge 250k + buffer for eggs/breed) — rich accounts only
    // Relic enhancing (2026-07-06, friend): the 3 Legendary trainer relics we enhance each "straight to
    // two levels, that's another +100k gold each" (~1.1M gold/account together with the forge) — it speeds
    // up hatching/stamina. The old reason for disabling it ("ate the Gold needed for eggs") is closed by the filters below.
    autoEnhanceRelics: true,
    enhanceRelicClasses: ['trainer'],    // ONLY trainer relics (there are 3/account); pet relics number 200+ — enhancing them all is ruinous
    enhanceMinGold: 300000,              // enhance only at gold ≥ 300k — protects the egg/breed budget (modeled on forgeMinGold)
    enhanceMaxLevel: 2,                  // friend: "straight to two levels" — don't enhance beyond that

    autoSellGold: true,
    autoSellJunk: true,
    autoSellJunkRelics: false,           // do NOT sell relics (party_power / depth)
    autoSellJunkCreatures: true,         // 2026-07-05: owner topped up 10 wallets to >10k ZOLANA — enable selling. marketSellMinZolana below self-gates per account: accounts still <10k just skip cashout (log "cashout skip"), no 403
    // Common → XP recycling; Uncommon → sale at floor-undercut. ⚠️ IRREVERSIBLE. Rare+/special are protected.
    autoRecycleCreatures: true,
    recycleFodderRarities: ['common'],   // Common → XP always (we don't breed them)
    recycleExhaustedRarities: ['uncommon'], // Uncommon → XP ONLY after 8/8 breeds (friend: an exhausted breeder into XP; non-exhausted = breeding stock). Keep Rare/Epic for sale.
    recycleProtectSpecialVariants: true,
    autoVaultWhenFull: true,             // "rares into the vault" when the roster is full: frees a slot for hatch, the Rare+ is preserved in storage (not sold/burned). Only when the roster is full → no throughput loss.
    autoVaultSwap: true,                 // 2026-07-05: continuous roster polishing — if a vaulted Rare+ is more valuable than the weakest active runner, swap them (otherwise the vault accumulates upgrades that never return to battle)
    autoBreedingPipeline: true,           // 2026-07-06: owner — "let them breed, but in the vault": keep a pool of 10 in the vault for breeding (free there), release on 8/8 exhaustion for sale
    // Epic added 2026-07-06 (owner: "epics should breed too") — previously Epic only fell into the general
    // breedMinRarity..breedMaxRarity range (bot.js), i.e. it bred only if it happened to remain in the yard
    // and found a same-species partner there — competing for a slot with dungeons, without the dedicated
    // free parking path Uncommon/Rare already have. Now Epic enters the vault for breeding via the same
    // code (pickBreedingIntake/Graduate are already parameterized by rarity, no logic change needed).
    // Note: the pool of vaultBreedingPoolTarget is SHARED across all three rarities (not a separate limit
    // per Epic) — if it starts crowding Uncommon/Rare out of the pool, add a dedicated target for Epic.
    vaultBreedingRarities: ['uncommon', 'rare', 'epic'],
    // 2026-07-06 (owner: "breed everyone, nothing conflicts, from vault and from fleet, there's room for
    // eggs, incubate 6 at once") — the vault became a NURSERY: intake takes uncommon+ of ANY stage
    // (feeding/evolution work in the vault too), including bound. Found live: the roster is 50/50 on the
    // top accounts, all valves powerless (commons ran out, uncommons protected until 8/8, the Rare+ valve
    // doesn't see them) → hatch squad-full → ready eggs hold the incubator for HOURS → breeding stalls too.
    // A pool of 40 + batch intake unload the roster into the vault, hatch frees up, the incubator turns.
    // 2026-07-06: raised 40→60. With the graduate-vs-intake cancellation fixed (see handleDungeons), intake
    // net-frees active slots for hatching until the vault reaches this target; a higher target = more
    // hatching headroom before an account saturates (roster + vault full). The server allows ≥36 (seen
    // live); intake caps gracefully (409 → silent break) at whatever the real storage limit is.
    vaultBreedingPoolTarget: 60,
    vaultIntakeMaxPerTick: 5,               // batch intake: one per 10-20 min would unload the roster into the vault over hours
    vaultIntakeCooldownMinMs: 3 * 60 * 1000,
    vaultIntakeCooldownMaxMs: 8 * 60 * 1000,
    junkMinBreedCount: 8,                 // the exhausted 8/8 always sell
    // 2026-07-06 (night: 1 sellable pet across the fleet, "not 1 sale — the module broke"): the "8/8 only"
    // gate choked the shelf — breeding spends attempts slowly (25m cooldown). Surplus beyond 4 per
    // (species,rarity) (= 2 breeding pairs) sells immediately; the ladder isn't hurt — stock remains, the dump proceeds.
    junkSurplusKeepPerSpecies: 4,
    // 2026-07-06 evening (owner: "we sold at a normal price, set prices people buy at, didn't dump on each
    // other, watched the overall economy") — the DEMAND model, replacing the morning's −25..35% dump: the
    // price base = the MEDIAN of real external sales of the rarity (what people actually buy at); no sales
    // in the window → just below the cheapest EXTERNAL ask; never undercut our own fleet ask (a ladder
    // against self-dumping — 18 accounts don't chase the price down after each other). A stale lot cheapens
    // in steps of −12%/hour FROM ITS OWN price (the market says "no buyers" — we descend to the demand
    // level, not punch through it).
    cashoutPriceJitterPct: 0.03,
    cashoutUndercutPctMin: 0,
    cashoutUndercutPctMax: 0,
    cashoutDemandPricing: true,
    // Ideal price is parsed per SPECIES first (median of that species' real sales), falling back to
    // rarity then seed — see creatureIdealPriceUsd. Trust a species' median only with ≥2 real sales;
    // below that the market is too thin for that species and we use its floor, then the rarity signal.
    cashoutSpeciesMinSamples: 2,
    cashoutMaxPriceOverFloor: 10,  // 2026-07-06 ("почему так дорого листим"): a thin/outlier clearing median
    // priced an Uncommon at $1.67 on a $0.05 floor (+3240%). Sanity cap = floor × this; a real median runs a
    // few× the min-floor on a thin market, so 10× is generous but blocks a polluted price from listing us out.
    cashoutAskUndercutPct: 0.05,
    cashoutRepriceDecayPct: 0.12,
    cashoutMinPriceUsd: 0.01,
    // 2026-07-06 (owner: "sell chaotically, at the pace the market needs — from the last 10-100 sales and
    // their timestamps"): the listing cooldown is derived from the market's absorption rate (external
    // sales/hour), the fleet occupies ~40% of demand and doesn't flood the book. Chaos ±40% is built into planListingPace.
    cashoutAdaptivePacing: true,
    cashoutFleetSellers: 18,
    cashoutMarketSharePct: 0.4,
    cashoutPacingMaxMs: 4 * 60 * 60 * 1000,
    cashoutListChance: 0.6,              // Task-1: list in only ~60% of ready windows → a chaotic listing moment (not clockwork), with a short re-schedule on a skip
    // Pull tokens out even during scaling (3 days of levelling have passed) — don't wait for isDoneScaling.
    autoSellDuringScaling: true,
    cashoutTargetZolana: 100_000,        // upper stop: accumulate up to 100k ZOLANA per wallet
    marketSellMinZolana: 10_000,         // 2026-07-05: the server's listing gate — "Hold at least 10,000 $ZOLANA". A self-balancing per-account threshold (hasMarketSellAccess): those with a balance ≥10k sell, those below wait quietly (no 403 spam), it triggers on its own as new wallets fill up
    fleetWallets: fleetWalletAddresses(),
    // 2026-07-06 (owner: "dump gold in 100k+ lots when there's a surplus and enough for everything, count
    // everything + a 1.5x reserve" → refined with concrete numbers: "when 1.5M accumulates let it dump 1M,
    // gradually, in 100k lots"). BUG FOUND: gold never sold once in the whole session — the base defaults
    // (cashoutGoldReserve/cashoutMinLotGold = 50000/50000) were never overridden here. BUT even with the
    // right numbers, a bare "reserve floor" without a separate trigger would give the WRONG behavior: sales
    // would start already at gold > 600k (reserve+minLot) and resume on every small increase after a sale —
    // not "accumulate to 1.5M, dump, wait for a NEW full set." So a separate hysteresis trigger
    // (cashoutGoldSellTrigger, see tryListGold/goldSellArmed): armed only at gold≥1.5M, disarmed only when
    // the surplus depletes back to the reserve. A 500k reserve (after a dump ~500k remains) covers all
    // current Gold sinks with plenty to spare (breeding 30-80k/attempt, forgeMinGold=400k, minGoldReserve=2500)
    // — that's "count everything," without a separate formula per sink. Lot ~100k: cashoutMinLotGold=100k
    // (min size), cashoutChunkFracMin/Max=0.08-0.14 at surplus ~1M (gold=1.5M) → lots ~80-140k (not
    // perfectly round — more human); lots shrink on their own as the sell-down approaches the reserve — "gradually" is built in.
    cashoutGoldReserve: 500_000,
    cashoutGoldSellTrigger: 1_500_000,
    cashoutMinLotGold: 100_000,
    cashoutChunkFracMin: 0.08,
    cashoutChunkFracMax: 0.14,
    cashoutGoldWeight: 1,
    cashoutCreatureWeight: 3,            // actively list Uncommon creatures (stamina coverage)
    cashoutMaxActiveListings: 3,
    cashoutMaxActiveCreatureListings: 9,
    cashoutPriceJitterMin: 1,            // price = external floor ("at market")
    cashoutPriceJitterMax: 1,
    // Medium pace: relist about once an hour, shorter cooldown between lots.
    cashoutListCooldownMinMs: 8 * 60 * 1000,
    cashoutListCooldownMaxMs: 25 * 60 * 1000,
    cashoutRepriceEnabled: true,
    cashoutRepriceMinAgeMs: 60 * 60 * 1000,
    cashoutRepriceMinDropPct: 0.05,
    // Sell Uncommon + Rare (the normal variant, any stage) at floor-undercut. Common goes into XP recycling
    // (not here). Epic/Legendary/Mythical and special variants (Shiny/Golden/Shadow/Rainbow) are NOT touched
    // — we hold them, EXCEPT the targeted exceptions in junkVariantRarityOverrides below.
    // Epic is deliberately NOT here, even though it's added to vaultBreedingRarities above (2026-07-06, owner:
    // "no need to sell epics yet, until we accumulate enough to farm and breed"): breed_count>=8 means "used
    // up its breeds", NOT "useless in dungeons" — a strong Epic fighter stays valuable for party_power/depth
    // even after exhausting its breed attempts, unlike Uncommon/Rare where that's less critical. While the
    // goal is to grow the Epic population, selling would cut exactly what we want to grow. Revisit once enough stock accumulates.
    // 2026-07-06 (owner): sell ONLY Uncommon. Rare removed — with the shift to "accumulate a full fleet of
    // epics" every rare = raw material for the epic ladder (rare+rare → an epic egg); even an exhausted 8/8
    // rare stays a dungeon fighter (party_power). Bring rare back once epics are plentiful.
    junkCreatureRarities: ['uncommon'],
    junkCreatureStages: ['Baby', 'Juvenile', 'Adult', 'Elder'],
    junkCreatureVariants: ['normal', ''],
    junkVariantRarityOverrides: ['uncommon:rainbow'], // 2026-07-06 (friend): uncommon rainbow is also sold on exhaustion (via the same vault pipeline), at $0.2 (see CREATURE_VARIANT_PRICE_OVERRIDE_USD). Rare/Epic Rainbow and all Golden/Shadow stay protected.
    junkCreatureKeepPerSpecies: 0,       // sell everyone, keep nothing
    optimizeDepth: true,
    depthObjective: 'gold-per-run',
    dungeonId: 3,
    elementalEggAfter: 0,        // straight to "elemental" (i.e. lux) — the basic phase is done, no need for volume
    elementalEggTypes: ['lux'],  // lux only (60k) — uncommon breeding stock, not the 50k species lottery
    eggBuyDailyCap: 20,          // friend: "buy about 20" — the daily purchase ceiling
    eggQueueTarget: 6,
    // 2026-07-06: no more purchased eggs → all 6 incubator slots (wiki) belong to breeding eggs. The old
    // cap of 3 was a valve for "don't monopolize the incubator shared with purchased eggs" — without
    // purchased eggs it just halved breeding throughput.
    breedMaxPendingEggs: 6,
    // Multiple pairs per handleBreed call: a pool of 10 breeders in the vault = up to 5 pairs, but one breed
    // per 10 minutes (breedRetryMs) picked one — the rest sat idle while ready. Human: a player, having
    // opened the vault, breeds all ready pairs in a row, not one per visit.
    breedMaxPerTick: 3,
    minGoldReserve: 2500,
    ...overrides,
  };
}

export function buildBotConfig({
  name,
  jitter,
  strategy = {},
  overrides = {},
} = {}) {
  if (!name) throw new Error('startup profile: account name required');
  if (!jitter) throw new Error('startup profile: jitter required');
  return {
    name,
    ...strategy,
    ...farmTradingConfig(),
    rng: seededRandom(jitter.seed),
    actionDelayMinMs: jitter.actionDelayMinMs,
    actionDelayMaxMs: jitter.actionDelayMaxMs,
    tickMinSec: jitter.tickMinSec,
    tickMaxSec: jitter.tickMaxSec,
    ...overrides,
  };
}
