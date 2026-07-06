// Autonomous Zenko game loop. One instance = one account.
// Philosophy: free/Gold grind only. NEVER touches anything that moves $ZOLANA/SOL.
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_SOLANA_RPC,
  STAMINA_FULL_PACK,
  STAMINA_FULL_REFILL_COST_ZOLANA,
  ZOLANA_MINT,
  ZOLANA_TREASURY,
  createStaminaRefillPayment,
  staminaCostForDungeon,
} from './stamina.js';
import { appendLedgerEvent, openMarketListingsFromEvents, readLedgerEvents } from './ledger.js';
import { appendFloorSnapshot } from './market-history.js';
import { bestDepth } from './depth-optimizer.js';
import { planRelicEquip, planTrainerRelicEquip } from './relic-optimizer.js';
import { planBreedPair, describeBreedSkip } from './breeding.js';
import { shuffleWithRng } from './jitter.js';
import {
  isDoneScaling,
  planGoldListing,
  planUniqueFloorListing,
  pickJunkRelics,
  pickJunkCreatures,
  pickRecycleFodder,
  pickPlacedFodder,
  pickRecycleTarget,
  pickVaultCandidate,
  planVaultSwap,
  pickBreedingIntake,
  pickBreedingGraduate,
  activeListingCount,
  chooseCashoutLane,
  cancelListing,
  isActiveListing,
  listGold,
  listMarketItem,
  planListingReprice,
  parseListings,
  goldFloorUsd,
  getGoldFloorUsd,
  getMarketFloorUsd,
  getCreatureFloorAndVolumeByRarity,
  creatureFloorUsdForRarity,
  creatureIdealPriceUsd,
  creatureAsksBySpecies,
  marketTraitsOf,
  getMyListings,
  getMyGoldListings,
  getMySales,
  saleLedgerAmounts,
  newlySold,
  petFloorValueZolana,
  planOrganicPrice,
  planDemandPrice,
  planListingPace,
  creatureAsksByRarity,
} from './marketplace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs');

// One-per-process market preflight: the first bot to reach cashout checks the live API shapes
// (is there a `seller` in browse, a `buyer` in sales) and logs it — so `npm run system` itself
// confirms what the parser is tuned for, without a manual market-smoke.
let marketPreflightDone = false;

const STAGE_RANK = { Baby: 0, Juvenile: 1, Adult: 2, Elder: 3 };
const FEED_COOLDOWN_MS = 11 * 60 * 1000; // 11m, not 10: at exactly the 10-min server cooldown a feed sometimes isn't counted (lag)
// Quest rewards (from the bundle): onboarding o_* (one-time) + dailies d_* (reset per period).
// o_own4/8/14/20 and o_species5 unlock as the roster grows → the "eggs for rewards" meta.
const QUEST_IDS = ['o_place', 'o_own4', 'o_own8', 'o_own14', 'o_own20', 'o_species5', 'o_level2', 'd_place', 'd_gold', 'd_own3', 'd_equip'];
// Elemental eggs for 50k Gold (20% Rare). We rotate them for species variety (quest o_species5).
const ELEMENTAL_EGGS = ['forest', 'ocean', 'mountain', 'volcano', 'sky'];
// lux/void — premium eggs, 20% pricier than elemental (2026-07-06, friend: lux = uncommon breeding stock).
const EGG_COST = { basic: 2500, forest: 50000, ocean: 50000, mountain: 50000, volcano: 50000, sky: 50000, lux: 60000, void: 60000 };

// Endpoints the bot has no right to call (they move money).
const FORBIDDEN = [
  '/api/stamina/restore', '/api/market/', '/api/gacha/pull', '/api/gem/craft',
  '/api/epoch/donate', '/api/zothebyz/', '/api/casino/play', '/api/market/buy-gems',
];

const rnd = (a, b, rng = Math.random) => a + rng() * (b - a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const parseTime = (t) => (t ? Date.parse(t) : 0);
const isSameDay = (ts) => ts && new Date(ts).toDateString() === new Date().toDateString();
const clampDepth = (value, fallback = 1) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(25, n));
};

// Pure gate for forging a trainer relic (Task-2): whether to forge and which slot. gold ≥ forgeMinGold
// (protects the egg/breed budget — rich accounts only), a daily limit forgeDailyCap, slot rotation
// amulet→ring→idol by the number of forges today. Returns {slot, relicClass, costGold} or null.
export function planTrainerForge(cfg = {}, { gold = 0, forgesToday = 0 } = {}) {
  if (!(gold >= (Number(cfg.forgeMinGold) || 0))) return null;
  if (forgesToday >= Number(cfg.forgeDailyCap ?? 2)) return null;
  const slots = Array.isArray(cfg.forgeTrainerSlots) && cfg.forgeTrainerSlots.length
    ? cfg.forgeTrainerSlots : ['amulet', 'ring', 'idol'];
  return {
    slot: slots[forgesToday % slots.length],
    relicClass: cfg.forgeRelicClass || 'trainer',
    costGold: Number(cfg.forgeGoldCost) || 0,
  };
}

export class ZenkoBot {
  constructor(client, cfg = {}) {
    this.c = client;
    this.name = cfg.name || client.address.slice(0, 4);
    this.cfg = {
      dungeonId: 1,
      partySize: 3,
      feed: true,
      feedMaxPerTick: 3,       // cap on feeds per tick (human); farm raises it — dozens of Babies after an egg burst otherwise mature slower than possible
      autoEquipRelics: true,   // equip best relics by stats (free, reversible) → party_power → deeper dungeons
      relicStatWeights: {},    // stat weights for scoring a relic (default all 1)
      relicMaxCreatures: Infinity, // how many of the strongest creatures to equip (relics cap themselves)
      relicMaxActionsPerTick: Infinity, // 2026-07-06: batch cap on equip+unequip per call — without it a big
      // one-off backlog (e.g. after months of an idempotency bug — see relic-optimizer.js) could eat the whole tick
      // on human pauses between actions and never reach dispatchRuns; dungeons stayed silent until the gear was fully
      // sorted out. Infinity = old behavior (no cap). The farm profile sets a concrete number.
      relicRetryMs: 10 * 60 * 1000, // re-equip throttle
      // Trainer relics (2026-07-05): a SEPARATE system from pet relics (class='trainer', not 'combat',
      // one carrier — the trainer itself). Previously "equipping" existed only inside handleForgeTrainerRelic —
      // it blindly equipped the just-forged relic without comparing to the one already worn. Now there's an
      // independent periodic optimizer (the same principle as autoEquipRelics), free/reversible, on by default.
      autoEquipTrainerRelics: true,
      trainerRelicRetryMs: 10 * 60 * 1000, // trainer re-equip throttle
      autoEnhanceRelics: true, // Relic Forge (2026-07-03 update): enhance worn relics for Gold+materials → party_power ↑
      enhanceRetryMs: 10 * 60 * 1000, // relic-enhance throttle
      // Enhance focus (2026-07-06, friend: 3 Legendary trainer relics "straight to two levels, that's another
      // +100k gold each"): there are hundreds of pet relics — enhancing them all is ruinous, trainer relics are exactly 3.
      enhanceRelicClasses: null,  // null = all classes (old behavior); array of strings = enhance only these r.class
      enhanceMinGold: 0,          // enhance only at gold ≥ this (modeled on forgeMinGold — budget protection)
      enhanceMaxLevel: Infinity,  // don't enhance a relic whose enhance_level is already ≥ this
      autoEvolve: true,        // evolve the party for Gold (the power flywheel)
      // Cap evolution at Adult except top-tier rarities (2026-07-06, friend): Elder is a Gold sink with no
      // worthwhile party_power payoff for common..epic — and Adult is the breeding stage (Adult → vault →
      // breed → 8/8 → sell), so stopping there keeps the breeding conveyor fed. Only these rarities may
      // evolve Adult→Elder (premier dungeon runners). null = every rarity may reach Elder (old behavior).
      evolveElderRarities: null,
      autoBreed: true,         // tier-climb breeding for Gold (planBreedPair): same-species pairs to climb the tier
      breedBlessed: false,     // blessed:true adds a Gems surcharge — exact price unconfirmed, off by default
      breedRetryMs: 10 * 60 * 1000,
      breedMaxCount: 8,        // lifetime attempt cap per creature (success+fail) — don't exceed
      breedCooldownMs: 25 * 60 * 1000, // cooldown on both parents after an attempt
      breedMinHappiness: 50,   // happiness gate for breeding
      breedMinRarity: 'common', // lower bound on breeding; the farm profile sets 'uncommon' (Common → XP fodder, don't breed)
      breedMaxRarity: 'epic',  // don't breed Legendary/Mythical (≈T4 end of the ladder / capped → server rejects)
      breedAllowStored: true,  // vaulted (safe) pets CAN breed (2026-07-05) — zero opportunity cost, they don't run dungeons anyway. false → disable if the server ever rejects/something breaks
      breedAllowCrossSpecies: false, // 2026-07-06 (friend: "one species, one rarity, one tier, for both — if they differ it's −1 level"): by default do NOT breed different species of the same rarity, even if there's no same-species duplicate (a mismatch is tolerated by the server but gives a knowingly worse result). true → enable the cross-species fallback for volume at the cost of quality
      breedGoldReserve: null,  // Gold reserve for breeding (null → use minGoldReserve). The farm profile protects the egg budget
      // Incubator pressure valve: a breeding egg occupies ONE of the few (per the wiki — 6) incubator slots
      // SHARED with purchased eggs for 30m–4h (by tier), whereas a purchased egg takes seconds-to-minutes.
      // Found live 2026-07-05: main had all 6/6 slots + 17 queued — ALL breeding eggs, purchased ones couldn't
      // enter the incubator at all. This is NOT about the roster (the vault is a different limit), it's that
      // breeding produces eggs faster than the incubator cooks them. The gate: don't start a new breed while
      // there are already many uncooked (status != hatched) breeding eggs — let the queue drain, freeing slots for purchased eggs too.
      breedMaxPendingEggs: 3,
      breedMaxPerTick: 1,      // how many pairs to breed per handleBreed call (the farm profile raises it — see startup-profile.js)
      // Trainer Relic Forge (friend: 3 relics on the character → pets born 2× faster; 250k gold+materials each, 2/day).
      // ⚠️ PARAMS NOT CONFIRMED live (not a single trainer relic in the dumps). Money-safe: a wrong relicClass
      // is rejected by the server 400 (gold is NOT spent — only charged on success). Config-driven, so a
      // change is one line. Opt-in; farm enables it with a high forgeMinGold (rich accounts only).
      autoForgeTrainerRelic: false,
      forgeRelicClass: 'trainer',            // best-inference class string of the trainer relic for /api/relic/craft
      forgeTrainerSlots: ['amulet', 'ring', 'idol'], // forge order (friend: amulet+ring today, idol tomorrow)
      forgeDailyCap: 2,                      // the server's daily forge limit (friend: 2/day)
      forgeGoldCost: 250000,                 // ~price per forge (for the ledger; the server doesn't return the real one)
      forgeMinGold: 400000,                  // forge ONLY when gold ≥ this — protects the egg/breed budget (rich accounts only)
      forgeRetryMs: 60 * 60 * 1000,          // forge-attempt throttle (a daily action, no point spamming)
      afkZone: true,           // AFK zone: ×2 stamina regen
      autoBuyEggs: false,      // ongoing buying of eggs for Gold — off by default (established accounts breed only)
      // New-account bootstrap: a fresh account buys a one-time batch of 50k elemental eggs to seed a
      // breeding roster, then breeds only (see handleEggs). Off by default; the farm profile turns it on.
      // Auto-gated to new accounts (small roster + few lifetime egg buys) so it never touches established ones.
      bootstrapEggBuy: false,
      bootstrapEggCount: 6,          // how many 50k eggs a new account buys, total, ever
      bootstrapRosterMax: 12,        // only bootstrap while the roster is below this (i.e. a new account)
      bootstrapEggTypes: ELEMENTAL_EGGS, // the 50k elemental eggs, rotated for species variety
      elementalEggAfter: 20,   // after N pets, switch from basic (2500) to elemental (50k, 20% Rare)
      elementalEggTypes: ELEMENTAL_EGGS, // which types to rotate after elementalEggAfter (farm sets ['lux'] — uncommon breeding stock)
      eggBuyDailyCap: Infinity, // max egg purchases per UTC day (farm sets 20 — friend: "buy about 20")
      eggQueueTarget: 4,       // how many non-hatched eggs to keep queued
      eggBuyRetryMs: 10 * 60 * 1000,
      eggHatchRetryMs: 10 * 60 * 1000,
      eggHatchSquadFullRetryMs: 60 * 1000, // squad-full → short retry (recycle/vault are actively freeing a slot), NOT 10 min — otherwise eggs pile up
      minGoldReserve: 0,       // keep a Gold reserve
      autoBuyStamina: false,
      staminaRefillPack: STAMINA_FULL_PACK,
      staminaRefillCostZolana: STAMINA_FULL_REFILL_COST_ZOLANA,
      minZolanaReserve: 0,
      staminaPayment: createStaminaRefillPayment,
      staminaRefillRetryMs: 2 * 60 * 1000,
      staminaPriceStaleBackoffMs: 6 * 60 * 60 * 1000, // "Payment was too small" → the price is stale, retrying is pointless (only burns ZOLANA) — long backoff until the constant is fixed manually
      persistStaminaPending: true,
      // 2026-07-06: soldMarketIds (dedupe set for market_sale ledger events) was in-memory-only —
      // every process restart (frequent under `--watch`) reset it, so the bot re-read the server's
      // whole sales history and re-recorded every past sale as "new". Found live: raw ledger showed
      // 75 market_sale events, real distinct sales (dedup by listingId) = 5 — a 15x inflation, actively
      // WORSENING with every restart (only 1 genuinely new sale between two checks a few hours apart,
      // but +34 phantom re-records). Persisted the same way as pendingStaminaRestore/session tokens.
      persistSoldMarketIds: true,
      // Gold cashout: sell surplus Gold → $ZOLANA on the marketplace once done scaling.
      // Opt-in only (same tier as autoBuyStamina). Seller-passive: never signs a tx.
      autoSellGold: false,
      cashoutDepthTarget: 25,          // "done" when ceiling reaches this…
      cashoutPlateauTicks: 20,         // …or ceiling unchanged this many ticks (party_power plateau)
      cashoutGoldReserve: 50000,       // keep this much Gold per account for ongoing sinks
      cashoutMinLotGold: 50000,        // don't list smaller than this (fee + look-normal)
      // 2026-07-06: hysteresis trigger (owner: "when 1.5M accumulates let it dump 1M, gradually") — a
      // SEPARATE threshold from cashoutGoldReserve. Without it a bare reserve gives the wrong behavior:
      // selling would start already at gold > reserve+cashoutMinLotGold (e.g. 600k) rather than when a truly
      // large amount has accumulated — and, worse, would immediately resume every tick as soon as gold grows
      // a little above that narrow threshold after a previous sale, instead of waiting for a new full
      // accumulation. null/0 (default) = hysteresis off, old behavior (reserve = immediate start threshold).
      // The farm profile sets a real number — see goldSellArmed below and tryListGold.
      cashoutGoldSellTrigger: null,
      cashoutMinPriceUsd: 0.05,        // don't list a lot cheaper than this
      cashoutChunkFracMin: 0.2,        // human: list a random fraction of surplus, not all
      cashoutChunkFracMax: 0.5,
      cashoutPriceJitterMin: 1,        // price at live floor by default; only jitter upward if configured
      cashoutPriceJitterMax: 1,
      cashoutPriceJitterPct: 0,        // Task-1: symmetric ± price jitter for CREATURES around the floor (0 = exactly floor). farm sets ~0.03 → "+- one clear price", organic, not a floor−ε undercut wall
      cashoutUndercutPctMin: 0,        // 2026-07-06 dump mode: >0 → price = floor×(1−uniform[min..max]) BELOW the floor; overrides the jitter (see planOrganicPrice)
      cashoutUndercutPctMax: 0,
      // Demand model (2026-07-06, evening — replaces the −25..35% dump): price = the median of real sales
      // (clearing) → a bit below the min external ask → seed; don't undercut our own fleet ask (a ladder).
      cashoutDemandPricing: false,
      cashoutSpeciesMinSamples: 2,     // trust a species' median (clearing) only with ≥ this many real sales; fewer → fall back to its floor, then rarity
      cashoutAskUndercutPct: 0.05,     // no sales in the window: our ask = external min × (1−this)
      cashoutRepriceDecayPct: 0,       // >0: a stale lot cheapens in steps ×(1−decay) from the CURRENT price
      // Adaptive listing pace from the market pulse (see planListingPace / salesVelocityPerHour)
      cashoutAdaptivePacing: false,
      cashoutFleetSellers: 1,          // how many of OUR accounts sell at once (we split the market share among all)
      cashoutMarketSharePct: 0.4,      // what share of the market's speed the fleet takes
      cashoutPacingMaxMs: 4 * 60 * 60 * 1000, // cap on the pause on a dead market
      cashoutListChance: 1,            // Task-1: probability of actually listing when ready (1 = always). farm <1 → a chaotic listing moment (not clockwork), with a short re-schedule on a skip
      cashoutListCooldownMinMs: 20 * 60 * 1000, // human cadence between listings
      cashoutListCooldownMaxMs: 90 * 60 * 1000,
      cashoutRepriceEnabled: true,
      cashoutRepriceMinAgeMs: 4 * 60 * 60 * 1000,
      cashoutRepriceMinDropPct: 0.05,
      marketSellMinZolana: 0,
      autoSellDuringScaling: false, // by default we only sell once "scaled up" (isDoneScaling); the farm profile enables selling during scaling
      cashoutTargetZolana: Infinity, // upper stop by ZOLANA on the wallet (the farm profile sets 100k); Infinity/0 = no limit
      fleetWallets: [],             // our own wallet addresses — excluded from the floor calc (don't dump on each other)
      cashoutGoldWeight: 1,
      cashoutCreatureWeight: 3,
      cashoutMaxActiveListings: 3,
      cashoutMaxActiveCreatureListings: 9,
      autoSellJunk: false,             // opt-in: seller-side liquidation of conservative junk only
      autoSellJunkRelics: true,
      autoSellJunkCreatures: false,
      junkRelicRarities: ['common'],
      junkRelicKeepPerKey: 2,
      junkCreatureRarities: ['common'],
      junkCreatureVariants: ['normal', ''],
      junkCreatureStages: ['Baby', 'Juvenile'],
      junkCreatureKeepPerSpecies: 2,
      // Recycling pets into XP (sacrifice → XP). ⚠️ IRREVERSIBLY deletes fodder pets —
      // strictly opt-in, never default-on (same tier as autoBuyStamina, see NOTES).
      autoRecycleCreatures: false,
      autoUnplaceFodder: true,               // unplace fodder pets from island plots so they go into XP (place-auto parked them → they got stuck out of sacrifice)
      // Vault valve: "rares into the vault" ONLY when the roster is full (otherwise the vault removes a pet
      // from dungeon rotation → less gold). Frees a slot for hatch + preserves Rare+ in storage. Opt-in.
      autoVaultWhenFull: false,
      vaultRosterFull: 49,                   // trigger: this many creatures on the account → the roster is practically full (cap ~50)
      vaultKeepStrongestRareplus: 6,         // keep the top-N Rare+ as dungeon runners; vault only beyond that
      // Fleet↔vault swap: a continuous optimizer ON TOP of autoVaultWhenFull (that one hides once under
      // pressure and forgets — the vault accumulates upgrades that never return). An independent opt-in:
      // not tied to roster fullness, fires when a vaulted Rare+ is more valuable than the weakest active
      // runner by a meaningful margin. Free/reversible (store:true↔store:false).
      autoVaultSwap: false,
      vaultSwapMinValueMargin: 1000,          // min gap in rareplusValue for a swap (1000 = one stage-rank) — a filter against thrashing
      vaultSwapCooldownMinMs: 20 * 60 * 1000, // rarer than the vault itself — this is "polishing" the roster, not a firefighting valve
      vaultSwapCooldownMaxMs: 40 * 60 * 1000,
      // Dedicated in-vault breeding pipeline (2026-07-06, owner: "let them breed, but in the vault, they need
      // to be moved around and then sold on the market"): deliberately keep a pool of N Uncommon/Rare INSIDE
      // the vault specifically for breeding (it's free there — see planBreedPair/handleBreed), rather than
      // waiting for them to land there reactively via roster pressure. Once a pet in the pool exhausts 8/8 —
      // release it back, then ordinary selling picks it up (junkMinBreedCount).
      autoBreedingPipeline: false,
      vaultBreedingRarities: ['uncommon', 'rare'],
      vaultBreedingPoolTarget: 10,             // how many to keep in the vault for breeding at once (the farm profile raises it — the vault nursery)
      vaultIntakeMaxPerTick: 1,                // intakes into the vault per call (farm raises it — unload the full roster)
      vaultBreedingKeepStrongest: 0,           // reserve "don't touch the top-N" WITHIN the Uncommon/Rare pool (separate from vaultKeepStrongestRareplus — that's about Rare+ dungeon runners)
      vaultIntakeCooldownMinMs: 10 * 60 * 1000,
      vaultIntakeCooldownMaxMs: 20 * 60 * 1000,
      vaultGraduateCooldownMinMs: 8 * 60 * 1000,
      vaultGraduateCooldownMaxMs: 15 * 60 * 1000,
      recycleFodderRarities: ['common', 'uncommon'],
      recycleExhaustedRarities: [],          // rarities → XP ONLY once they've exhausted 8/8 breeds (farm sets ['uncommon'])
      recycleProtectSpecialVariants: true,   // don't sacrifice Golden/Shadow/Shiny/Rainbow even among Common
      recycleMaxPerTick: 5,                  // a small batch = human + a safety valve against a bug
      recycleCooldownMinMs: 5 * 60 * 1000,
      recycleCooldownMaxMs: 15 * 60 * 1000,
      recycleDryRun: false,                  // true → only log the plan, don't sacrifice
      maxConcurrentRuns: Infinity, // how many parallel runs to start per tick (Infinity = the whole idle roster)
      optimizeDepth: false,        // aim for the optimal depth (by ledger), not the deepest; opt-in
      depthObjective: 'gold-per-stamina', // 'gold-per-stamina' (stamina scarce) | 'gold-per-run' (unlimited tokens → max levelling/run)
      depthMinSamples: 3,          // how many runs at a depth are needed to trust its statistics
      depthRecalcMs: 10 * 60 * 1000, // how often to recompute the optimum by ledger
      epsilonProbe: true,          // periodically try ceiling+1 (otherwise optimizeDepth freezes the ceiling forever)
      depthProbeMs: 20 * 60 * 1000, // how often to force a probe past the ceiling (re-evaluate power after levelling/evolutions)
      adaptiveTick: true,          // wake to the nearest finishing run rather than on a random interval
      solanaRpcUrl: process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC,
      zolanaMint: ZOLANA_MINT,
      zolanaTreasury: ZOLANA_TREASURY,
      ledger: true,
      refreshLiveState: true,
      tickMinSec: 45,
      tickMaxSec: 120,
      urgentTickMinSec: 8,
      urgentTickMaxSec: 20,
      actionDelayMinMs: 400,
      actionDelayMaxMs: 1600,
      shuffleSafeActions: false,
      rng: Math.random,
      ...cfg,
    };
    this.rng = this.cfg.rng || Math.random;
    this.firstTick = true;
    // dungeon-depth self-calibration
    this.depth = clampDepth(this.cfg.depth, clampDepth(this.cfg.dungeonId || 1));   // current target
    this.depthCeiling = clampDepth(this.cfg.depthCeiling, this.depth);          // verified ceiling, not assumed d25
    this.nextProbeAt = 0;                    // when we may probe past the ceiling again
    this.efficientDepth = this.cfg.efficientDepth == null ? null : clampDepth(this.cfg.efficientDepth);              // cached depth with the best Gold/stamina (null = too little data → greedy mode)
    this.nextDepthCalcAt = 0;                // throttle for recomputing the optimum by ledger
    this.nextForcedProbeAt = 0;              // when to force an ε-probe past the ceiling
    this.nextEvolveAt = 0;                   // evolve-attempt throttle
    this.nextEnhanceAt = 0;                  // relic-enhance (Forge) throttle
    this.nextRelicAt = 0;                    // relic re-equip throttle
    this.nextTrainerRelicAt = 0;             // trainer re-equip throttle
    this.nextBreedAt = 0;                    // breed-attempt throttle
    this.nextRewardsAt = 0;                  // quest/reward claim throttle
    this.nextEggBuyAt = 0;
    this.nextEggHatchAt = 0;
    this.elemIdx = 0;                        // elemental egg rotation
    this.afkStarted = false;
    this.nextStaminaRefillAt = 0;
    this.pendingStaminaRestore = null;
    this.recentLog = [];  // ring buffer of lines for the web dashboard
    this.goldHistory = []; // [{t, gold}] for the chart
    this.zolanaHistory = []; // [{t, zolana}] for ZOLANA/h
    this.petValueHistory = []; // [{t, zolana: unbound-sellable, all: mark-to-market}] for pet-value ZOLANA/h
    this.priceUsd = null;
    this.creatureFloorZolana = {};   // creature floor by rarity in $ZOLANA (real sales), for the dashboard
    this.creatureMetricsBySpecies = {}; // per-species {rarity, floorUsd, clearingUsd, count} — the ideal-price base
    this.nextFloorAt = 0;            // throttle for collecting the market floor
    // cashout state: plateau tracking + human cadence + ledgered-sale dedupe
    this.lastCeiling = this.depthCeiling;
    this.ceilingStableTicks = 0;
    this.nextCashoutAt = 0;
    this.goldSellArmed = false; // 2026-07-06: gold-sale hysteresis trigger — see cashoutGoldSellTrigger/tryListGold
    this.nextRecycleAt = 0;
    this.nextVaultAt = 0;                     // vault-valve throttle
    this.nextVaultSwapAt = 0;                 // fleet↔vault swap throttle
    this.nextVaultIntakeAt = 0;               // throttle for intake into the vault for breeding
    this.nextVaultGraduateAt = 0;             // throttle for release from the vault on breed exhaustion
    this.nextBreedSkipLogAt = 0;              // throttle for "why breeding didn't fire" diagnostics (2026-07-05)
    this.nextForgeAt = 0;                     // trainer-relic forge throttle
    this.forgeDay = null;                     // UTC day for the forge's daily limit
    this.forgesToday = 0;                     // how many forges today
    this.eggBuyDay = null;                    // UTC day for the egg-purchase daily limit (seeded from the ledger — see handleEggs)
    this.eggBuysToday = 0;                    // how many eggs bought today
    this.creatureUnlistDone = false; // one-time unlisting of creature listings when creature selling is off
    this.soldMarketIds = new Set();
    this.lastLiveState = null;      // the last successful snapshot — we serve it on a maintenance-skipped tick
    mkdirSync(LOG_DIR, { recursive: true });
    this.loadPendingStaminaRestore();
    this.loadSoldMarketIds();
  }

  log(...a) {
    const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`;
    console.log(`[${line.slice(0, 8)}][${this.name}]`, ...a);
    this.recentLog.push(line);
    if (this.recentLog.length > 30) this.recentLog.shift();
  }

  rand(a, b) {
    return rnd(a, b, this.rng);
  }

  orderedActions(actions) {
    return this.cfg.shuffleSafeActions ? shuffleWithRng(actions, this.rng) : actions;
  }

  recordEvent(type, event = {}) {
    if (!this.cfg.ledger) return null;
    try {
      return appendLedgerEvent(this.name, { type, ...event });
    } catch (e) {
      this.log('ledger err', type, (e.message || '').slice(0, 80));
      return null;
    }
  }

  // Seed for the depth optimizer. Extracted into a method so tests can inject history without disk.
  loadLedgerEvents() {
    try { return readLedgerEvents(this.name); } catch { return []; }
  }

  writeLive(state) {
    const p = state.player || {};
    const now = Date.now();
    this.goldHistory.push({ t: now, gold: p.gold ?? 0 });
    if (this.goldHistory.length > 120) this.goldHistory.shift();
    this.zolanaHistory.push({ t: now, zolana: p.zenko_balance ?? 0 });
    if (this.zolanaHistory.length > 120) this.zolanaHistory.shift();
    // Pet value by floor: sellable = unbound only (actually sellable), all = mark-to-market (counts even
    // bound pets, which CAN'T be sold — ~⅔ of the fleet). From the sellable history we take the honest ZOLANA/hour.
    const floorMap = this.creatureFloorZolana || {};
    const petSellableZ = petFloorValueZolana(state.creatures || [], floorMap, { unboundOnly: true });
    const petAllZ = petFloorValueZolana(state.creatures || [], floorMap, { unboundOnly: false });
    this.petValueHistory.push({ t: now, zolana: petSellableZ, all: petAllZ });
    if (this.petValueHistory.length > 120) this.petValueHistory.shift();
    const placed = (state.creatures || []).filter(c => c.plot_x != null).length;
    const runs = (state.dungeonRuns || []).filter(r => r.status !== 'claimed' && r.status !== 'done').length;
    // list of creatures with rarity/variant — so we can see the valuable ones (Rare+, Shiny/Rainbow).
    // The name comes from species or creature_id (in the live state the field is called creature_id).
    // allCreatures (2026-07-06) — vaulted-for-breeding creatures live in state.stored.creatures, not in
    // state.creatures; the dashboard used to ALWAYS show stored=0 (not because the vault was empty, but
    // because we read the wrong array) — the same confusion that hid the dead vault-breeding code.
    const creaturesList = this.allCreatures(state).slice(0, 80).map(c => ({
      id: c.id,
      species: c.species || c.creature_id, rarity: c.rarity, variant: c.variant, stage: c.stage, level: c.level,
      xp: c.xp,
      breed_count: c.breed_count,
      bound: c.bound,
      stored: c.stored === true, // in the vault — without this field you couldn't check from the monitor whether autoVaultWhenFull actually fired
      status: c.status,
      placed: c.plot_x != null,
    }));
    const relics = state.relics || [];
    const dungeonRuns = (state.dungeonRuns || []).filter(r => this.isActiveRun(r)).slice(0, 80).map(r => ({
      id: r.id,
      run_id: r.run_id,
      status: r.status,
      dungeon_id: r.dungeon_id,
      dungeonId: r.dungeonId,
      ready_at: r.ready_at,
      ends_at: r.ends_at,
      party: r.party || [],
    }));
    const eggsList = (state.eggs || []).filter(e => e.status !== 'hatched').slice(0, 40).map(e => ({
      id: e.id,
      egg_type: e.egg_type,
      status: e.status,
      hatch_ready_at: e.hatch_ready_at,
    }));
    const materialsList = (state.materials || []).slice(0, 120).map(m => ({
      id: m.id,
      type: m.type || m.material || m.name,
      material: m.material,
      quantity: m.quantity,
      amount: m.amount,
    }));
    const relicsList = relics.slice(0, 120).map(r => ({
      id: r.id,
      class: r.class,
      slot: r.slot,
      rarity: r.rarity,
      equipped_on: r.equipped_on,
      equip_slot: r.equip_slot,
      listed: r.listed,
      stored: r.stored,
      affixes: r.affixes,
    }));
    const live = {
      name: this.name,
      address: this.c.address,
      ts: now,
      priceUsd: this.priceUsd,
      creatureFloorZolana: this.creatureFloorZolana,   // creature floor by rarity in $ZOLANA (real sales)
      player: { gold: p.gold, gems: p.gems, level: p.level, xp: p.xp, stamina: p.stamina, zenko_balance: p.zenko_balance, place_slots: p.place_slots },
      counts: {
        creatures: (state.creatures || []).length, placed,
        eggs: (state.eggs || []).length,
        pendingEggs: (state.eggs || []).filter(e => e.status !== 'hatched').length,
        runs, mats: (state.materials || []).length,
      },
      // current depth target/ceiling — shows whether dungeon difficulty is climbing (ε-exploration)
      dungeon: { depth: this.depth, ceiling: this.depthCeiling, efficient: this.efficientDepth },
      // relics: total and how many equipped — shows whether auto-equip is working (party_power ↑)
      relics: { total: relics.length, equipped: relics.filter(r => r.equipped_on != null).length },
      creaturesList,
      dungeonRuns,
      eggsList,
      materialsList,
      relicsList,
      goldHistory: this.goldHistory,
      zolanaHistory: this.zolanaHistory,
      petValueHistory: this.petValueHistory,
      petValue: { sellableZolana: petSellableZ, allZolana: petAllZ },
      log: this.recentLog,
    };
    try { writeFileSync(join(LOG_DIR, `live-${this.name}.json`), JSON.stringify(live)); } catch { /* noop */ }
  }

  // Wrapper with protection against forbidden endpoints.
  async act(path, body) {
    if (FORBIDDEN.some(f => path.startsWith(f) || path.includes(f))) {
      throw new Error(`BLOCKED money endpoint: ${path}`);
    }
    const r = await this.c.api(path, body);
    await sleep(this.rand(this.cfg.actionDelayMinMs, this.cfg.actionDelayMaxMs)); // human pause between actions
    return r;
  }

  pendingStaminaPath() {
    return join(LOG_DIR, `stamina-${this.name}-pending.json`);
  }

  loadPendingStaminaRestore() {
    if (!this.cfg.persistStaminaPending) return;
    try {
      if (!existsSync(this.pendingStaminaPath())) return;
      const pending = JSON.parse(readFileSync(this.pendingStaminaPath(), 'utf8'));
      if (pending?.signature && pending?.pack) this.pendingStaminaRestore = pending;
    } catch { /* ignore corrupt pending file */ }
  }

  savePendingStaminaRestore() {
    if (!this.cfg.persistStaminaPending || !this.pendingStaminaRestore) return;
    try { writeFileSync(this.pendingStaminaPath(), JSON.stringify(this.pendingStaminaRestore)); } catch { /* noop */ }
  }

  clearPendingStaminaRestore() {
    this.pendingStaminaRestore = null;
    if (!this.cfg.persistStaminaPending) return;
    try { if (existsSync(this.pendingStaminaPath())) unlinkSync(this.pendingStaminaPath()); } catch { /* noop */ }
  }

  soldMarketIdsPath() {
    return join(LOG_DIR, `sold-ids-${this.name}.json`);
  }

  loadSoldMarketIds() {
    if (!this.cfg.persistSoldMarketIds) return;
    try {
      if (!existsSync(this.soldMarketIdsPath())) return;
      const ids = JSON.parse(readFileSync(this.soldMarketIdsPath(), 'utf8'));
      if (Array.isArray(ids)) this.soldMarketIds = new Set(ids);
    } catch { /* corrupt file — start from an empty set, at most one false "new" sale */ }
  }

  saveSoldMarketIds() {
    if (!this.cfg.persistSoldMarketIds) return;
    try { writeFileSync(this.soldMarketIdsPath(), JSON.stringify([...this.soldMarketIds])); } catch { /* noop */ }
  }

  async staminaPaymentSignature() {
    if (this.pendingStaminaRestore?.signature) return this.pendingStaminaRestore.signature;
    const pack = this.cfg.staminaRefillPack;
    const amountZolana = this.cfg.staminaRefillCostZolana;
    const signature = await this.cfg.staminaPayment(this.c.wallet, {
      pack,
      amountZolana,
      rpcUrl: this.cfg.solanaRpcUrl,
      mint: this.cfg.zolanaMint,
      treasury: this.cfg.zolanaTreasury,
    });
    if (!signature || typeof signature !== 'string') throw new Error('stamina payment did not return a transaction signature');
    this.pendingStaminaRestore = {
      signature,
      pack,
      amountZolana,
      createdAt: Date.now(),
      address: this.c.address,
    };
    this.savePendingStaminaRestore();
    return signature;
  }

  async handleStaminaRefill(state, dungeonId, staminaCost) {
    if (!this.cfg.autoBuyStamina) return false;
    const now = Date.now();
    if (now < this.nextStaminaRefillAt) return false;
    const p = state.player || {};
    const current = p.stamina;
    if (current != null && current >= staminaCost) return false;
    const spend = this.cfg.staminaRefillCostZolana;
    const reserve = this.cfg.minZolanaReserve || 0;
    if (p.zenko_balance != null && p.zenko_balance < spend + reserve) {
      this.nextStaminaRefillAt = now + this.cfg.staminaRefillRetryMs;
      this.log(`stamina refill skipped: ZOLANA ${p.zenko_balance} < ${spend + reserve}`);
      return false;
    }

    let signature = this.pendingStaminaRestore?.signature;
    try {
      signature = await this.staminaPaymentSignature();
      await this.c.api('/api/stamina/restore', { pack: this.cfg.staminaRefillPack, signature });
      await sleep(this.rand(this.cfg.actionDelayMinMs, this.cfg.actionDelayMaxMs));
      this.log(`STAMINA refill ${this.cfg.staminaRefillPack} for d${dungeonId} (${spend} ZOLANA) tx=${signature.slice(0, 10)}...`);
      this.recordEvent('stamina_refill', {
        amounts: { zolana: -spend },
        tx: signature,
        ref: { dungeonId, pack: this.cfg.staminaRefillPack },
        meta: { staminaCost },
      });
      this.clearPendingStaminaRestore();
      return true;
    } catch (e) {
      const msg = (e.bodyText || e.message || '').slice(0, 120);
      if (e.status && ![429, 503].includes(e.status) && !/chain|try again|timeout|network/i.test(msg)) {
        this.clearPendingStaminaRestore();
      }
      // "Payment was too small" = our configured price is stale (the server raised it) — the signature is
      // already cleared ABOVE, so the next attempt sends a NEW real on-chain payment for the same (still
      // wrong) amount → rejected again → burned again. Found live 2026-07-05: the whole fleet burned ZOLANA
      // every 2 min without a single credit, until the price went stale from 50 to 150. An ordinary retry
      // here ONLY speeds up the money burn — a long backoff doesn't solve the problem (needs a manual constant
      // fix), but it stops the bleeding until then rather than running it across the whole fleet.
      if (/too small/i.test(msg)) {
        this.nextStaminaRefillAt = now + (this.cfg.staminaPriceStaleBackoffMs ?? 6 * 60 * 60 * 1000);
        this.log('stamina refill err (STALE PRICE — configured amount too low, needs manual fix, backing off)', e.status || '', msg);
      } else {
        this.nextStaminaRefillAt = now + this.cfg.staminaRefillRetryMs;
        this.log('stamina refill err', e.status || '', msg);
      }
      return false;
    }
  }

  inMaintenance() {
    return (this.c?.maintenanceUntil || 0) > Date.now();
  }

  async tick() {
    let state;
    try {
      state = await this.c.api('/api/player/load');
    } catch (e) {
      if (e.maintenance || this.inMaintenance()) {
        // Show the backoff so it's clearly waiting-not-stuck. maintenanceWaitMs is set by the client on the
        // hit that armed the pause; otherwise derive the remaining wait from maintenanceUntil.
        const waitMs = e.maintenanceWaitMs ?? Math.max(0, (this.c?.maintenanceUntil || 0) - Date.now());
        const mins = waitMs >= 60000 ? `${Math.round(waitMs / 60000)}m` : `${Math.round(waitMs / 1000)}s`;
        this.log(`maintenance — server updating, waiting ~${mins} before next probe (no spam)`);
        return this.lastLiveState || null;
      }
      throw e;
    }
    if (this.firstTick) {
      writeFileSync(join(LOG_DIR, `${this.name}-first-state.json`), JSON.stringify(state, null, 2));
      const p = state.player || {};
      this.log(`online. gold=${p.gold} gems=${p.gems} lvl=${p.level} stamina=${p.stamina}/180 slots=${p.place_slots} creatures=${state.creatures.length} eggs=${state.eggs.length}`);
      try { this.priceUsd = (await this.c.api('/api/price')).zolanaPriceUsd; } catch {}
      this.firstTick = false;
    }

    // Creature market floor by rarity in $ZOLANA (for the dashboard) — throttled ~10 min, read-only.
    if (Date.now() >= this.nextFloorAt) {
      this.nextFloorAt = Date.now() + 10 * 60 * 1000;
      let floorsForSnapshot = null, countsForSnapshot = {}, clearingForSnapshot = null;
      try {
        if (!this.priceUsd) { try { this.priceUsd = (await this.c.api('/api/price')).zolanaPriceUsd; } catch {} }
        const { floors, counts, clearingUsd, variantFloors, metricsBySpecies, velocity } = await getCreatureFloorAndVolumeByRarity(this.c, { zolanaPriceUsd: this.priceUsd, fleetWallets: this.cfg.fleetWallets });
        // clearing (median of real sales, USD) — merge over last-known-good, like floors below
        if (clearingUsd && Object.keys(clearingUsd).length) this.creatureClearingUsd = { ...(this.creatureClearingUsd || {}), ...clearingUsd };
        // per-TRAIT floor ($ per rarity:variant) — merged last-known-good; special variants price off this (owner 2026-07-07)
        if (variantFloors && Object.keys(variantFloors).length) this.creatureVariantFloor = { ...(this.creatureVariantFloor || {}), ...variantFloors };
        // sale COUNT per rarity (same normal+external filter) — merged in lockstep with clearing so the
        // thin-data guard in creatureIdealPriceUsd knows how many sales are behind each median (a lone
        // outlier sale must NOT set the price — the $1.67 Uncommon, owner 2026-07-06).
        if (counts && Object.keys(counts).length) this.creatureSalesCount = { ...(this.creatureSalesCount || {}), ...counts };
        // Also snapshot the clearing (median) price per rarity in ZOLANA — the chart plots THIS, not the
        // raw min-floor: the min whipsaws 15× on a thin market (found live: common min 40 / median 501 /
        // max 7625), the median is the stable "price it actually sells at". Same USD→ZOLANA conversion as floors.
        if (clearingUsd && Object.keys(clearingUsd).length && this.priceUsd > 0) {
          clearingForSnapshot = {};
          for (const [r, usd] of Object.entries(clearingUsd)) if (usd > 0) clearingForSnapshot[r] = usd / this.priceUsd;
        }
        // per-species metrics (floor/clearing/count) — merge over last-known-good too: the thin market
        // rarely has a sale of every species per window, so replacing wholesale would drop a species'
        // ideal price to nothing the moment it had no sale this poll (same reasoning as floors below).
        if (metricsBySpecies && Object.keys(metricsBySpecies).length) this.creatureMetricsBySpecies = { ...(this.creatureMetricsBySpecies || {}), ...metricsBySpecies };
        if (velocity) this.marketVelocity = velocity; // market pulse (sales/hour) — sets the listing pace
        // MERGE, don't replace: the market is thin — the recent-sales window often does NOT contain sales of
        // some rarity, then getCreatureFloorAndVolumeByRarity won't return it. Replacing wholesale dropped its
        // floor to 0 → pet valuation swung wildly (e.g. 908K→184K in 10m when one uncommon deal landed). We
        // merge over last-known-good: update rarities with fresh sales, keep the rest.
        if (floors && Object.keys(floors).length) {
          this.creatureFloorZolana = { ...this.creatureFloorZolana, ...floors };
          floorsForSnapshot = floors;
          countsForSnapshot = counts;
        }
      } catch (e) { /* recent-sales unavailable — keep the previous values */ }
      // 2026-07-06: the external Gold→USD market rate — for "Profit today" (estimateProfitUsd) we need
      // something to convert gross Gold into, and Gold has no direct rate anywhere but market listings.
      // A separate try — a failure here shouldn't cost us the floors already read successfully above.
      let goldFloorUsd = null;
      try { goldFloorUsd = await getGoldFloorUsd(this.c, { fleetWallets: this.cfg.fleetWallets }); } catch { /* no gold listings right now — not critical */ }
      // Persist to disk for the candle chart and "Profit today" (market-history.js) — previously
      // creatureFloorZolana lived ONLY in process memory and was lost on every restart (including --watch).
      appendFloorSnapshot(this.name, floorsForSnapshot, countsForSnapshot, { goldFloorUsd, clearing: clearingForSnapshot });
    }

    // AFK zone: ×2 stamina regen (turn on once if not already active)
    if (this.cfg.afkZone && !this.afkStarted && !state.player?.afk_started_at) {
      try { await this.act('/api/afk/start'); this.log('AFK zone on (2× stamina regen)'); this.afkStarted = true; } catch { /* already on */ }
    }

    const preDungeonActions = [
      ['eggs', () => this.handleEggs(state)],
      ['placement', () => this.handlePlacement(state)],
    ];
    if (this.cfg.autoEquipRelics) preDungeonActions.push(['relics', () => this.handleRelics(state)]);
    if (this.cfg.autoEquipTrainerRelics) preDungeonActions.push(['trainerRelics', () => this.handleTrainerRelics(state)]);
    // vaultSwap/vaultGraduate/vaultIntake are NOT here (they were until 2026-07-06) — all three look for a
    // "free" active candidate (not in a run), but preDungeonActions runs BEFORE claim: run_id hasn't been
    // cleared from last tick's pets yet, so they almost always see "all busy" and don't fire. The same
    // mistake we fixed for recycle/vault a month ago — moved into handleDungeons, between claim and dispatch (see there).
    if (this.cfg.autoEnhanceRelics) preDungeonActions.push(['enhance', () => this.handleRelicEnhance(state)]);
    if (this.cfg.autoEvolve) preDungeonActions.push(['evolve', () => this.handleEvolve(state)]);
    if (this.cfg.autoBreed) preDungeonActions.push(['breed', () => this.handleBreed(state)]);
    if (this.cfg.autoForgeTrainerRelic) preDungeonActions.push(['forge', () => this.handleForgeTrainerRelic(state)]);
    for (const [, run] of this.orderedActions(preDungeonActions)) { if (this.inMaintenance()) break; await run(); }

    // Recycling is built into handleDungeons (between claim and dispatch) — there the commons are actually free.
    if (!this.inMaintenance()) await this.handleDungeons(state);

    // Track depth-ceiling plateau for cashout "done scaling" detection.
    if (this.depthCeiling > this.lastCeiling) { this.lastCeiling = this.depthCeiling; this.ceilingStableTicks = 0; }
    else { this.ceilingStableTicks++; }

    const postDungeonActions = [
      ['claims', () => this.handleClaims(state)],
      ['rewards', () => this.handleRewards(state)],
    ];
    if (this.cfg.feed) postDungeonActions.push(['feeding', () => this.handleFeeding(state)]);
    if (this.cfg.autoSellGold || this.cfg.autoSellJunk) postDungeonActions.push(['cashout', () => this.handleCashout(state)]);
    for (const [, run] of this.orderedActions(postDungeonActions)) { if (this.inMaintenance()) break; await run(); }

    let liveState = state;
    if (this.cfg.refreshLiveState && !this.inMaintenance()) {
      try { liveState = await this.c.api('/api/player/load'); }
      catch (e) { this.log('live refresh err', e.status || '', (e.bodyText || e.message || '').slice(0, 80)); }
    }
    // try/catch added 2026-07-06 (see allCreatures()): writeLive is the last step of the tick, and WITHOUT
    // this guard any unexpected exception here (not only the already-found-and-fixed case) would silently
    // kill the dashboard snapshot's visibility forever, while the farm itself (dungeons/feed/ledger above)
    // kept living — a confusing picture of "there's ledger activity but the dashboard doesn't update the account".
    try { this.writeLive(liveState); }
    catch (e) { this.log('writeLive err', (e.message || '').slice(0, 100)); }
    this.lastLiveState = liveState;
    return liveState;
  }

  // How long to sleep until the next tick. Adaptive: if a run is finishing soon — wake to it (+jitter)
  // so we can claim and restart immediately rather than losing minutes to a random tick. Ready/almost-ready
  // runs use a short urgent window; the idle cadence stays normal.
  nextWaitMs(state) {
    const nowMaint = Date.now();
    const maintUntil = this.c?.maintenanceUntil || 0;
    if (maintUntil > nowMaint) {
      // server under maintenance — wait until the end of the pause + jitter, so 18 accounts don't all wake
      // at once and salvo the server on its return.
      return Math.round((maintUntil - nowMaint) + this.rand(0, (this.cfg.tickMaxSec || 120) * 1000));
    }
    const minMs = this.cfg.tickMinSec * 1000;
    const maxMs = this.cfg.tickMaxSec * 1000;
    const urgentMinMs = Math.max(0, (this.cfg.urgentTickMinSec ?? 8) * 1000);
    const urgentMaxMs = Math.max(urgentMinMs, (this.cfg.urgentTickMaxSec ?? 20) * 1000);
    if (!this.cfg.adaptiveTick) return this.rand(minMs, maxMs);
    const now = Date.now();
    let soonest = Infinity;
    let readyNow = false;
    for (const run of state?.dungeonRuns || []) {
      if (!this.isActiveRun(run)) continue;
      const readyAt = parseTime(run.ready_at || run.ends_at);
      if (!readyAt) continue;
      if (readyAt <= now) {
        readyNow = true;
      } else {
        soonest = Math.min(soonest, readyAt - now);
      }
    }
    if (readyNow) return Math.round(this.rand(urgentMinMs, urgentMaxMs));
    if (Number.isFinite(soonest) && soonest < minMs) {
      return Math.round(Math.min(minMs, soonest + this.rand(urgentMinMs, urgentMaxMs)));
    }
    const base = Number.isFinite(soonest)
      ? Math.max(minMs, Math.min(soonest, maxMs)) // wake to the finishing run, but within bounds
      : this.rand(minMs, maxMs);                  // no active runs — the normal interval
    const jittered = base + this.rand(-0.1 * base, 0.1 * base); // ±10% desync between accounts
    return Math.round(Math.max(minMs, Math.min(maxMs, jittered)));
  }

  // Claim quest rewards + the free weekly holder Gem stipend.
  async handleRewards(state) {
    const now = Date.now();
    if (now < this.nextRewardsAt) return;
    this.nextRewardsAt = now + 8 * 60 * 1000;
    const claimed = state.player?.quest_claims || {};
    for (const qid of QUEST_IDS) {
      // an already-claimed onboarding quest — skip; try dailies always (the server sorts out the period)
      if (qid.startsWith('o_') && claimed[qid]) continue;
      try {
        const r = await this.act('/api/quests/claim', { questId: qid });
        const reward = r?.reward || {};
        this.recordEvent('quest_claim', {
          amounts: { gold: reward.gold || 0, gems: reward.gems || 0 },
          ref: { questId: qid },
          meta: { reward },
        });
        this.log(`QUEST ${qid} claimed${r?.reward?.gold ? ` (+${r.reward.gold}g)` : ''}`);
      } catch (e) {
        // 400/402/409 = quest not yet completed / already claimed — stay silent
        if (![400, 402, 409].includes(e.status)) this.log('quest err', qid, e.status);
      }
    }
    // weekly Gem stipend for $ZOLANA holders (free, the server limits the period itself)
    try {
      const r = await this.act('/api/gems/hold-claim', {});
      if (r?.gems) {
        this.recordEvent('gem_stipend', { amounts: { gems: r.gems }, ref: { source: 'hold-claim' } });
        this.log(`gem stipend +${r.gems}`);
      }
    }
    catch { /* already claimed this week */ }

    // epoch/claim — a separate free claim, NOT to be confused with epoch/donate (that's in FORBIDDEN and stays there)
    try {
      const r = await this.act('/api/epoch/claim', {});
      const gems = r?.gems ?? r?.gem;
      if (gems) {
        this.recordEvent('epoch_claim', { amounts: { gems }, ref: { source: 'epoch/claim' } });
        this.log(`epoch claim +${gems} gems`);
      }
    }
    catch { /* epoch not closed yet / already claimed */ }
  }

  // Auto-equip relics: the best relic by stats onto the strongest creatures (free, reversible).
  // party_power is the server's dungeon-depth gate, and relics raise it directly. best-effort:
  // an invalid slot/target pair is rejected by the server (400/402/409), handled silently like evolve/breed.
  // We unequip "moving" relics before equipping onto a new target (the server may require an empty slot).
  async handleRelics(state) {
    const now = Date.now();
    if (now < this.nextRelicAt) return;
    this.nextRelicAt = now + this.cfg.relicRetryMs;
    const relics = state.relics || [];
    if (relics.length === 0) return;
    const plan = planRelicEquip(relics, state.creatures || [], {
      weights: this.cfg.relicStatWeights,
      maxCreatures: this.cfg.relicMaxCreatures,
    });
    // Batch cap (2026-07-06): with a big one-off backlog (e.g. after months of an idempotency bug) do only
    // the first cap actions per call — the rest is picked up by the next call via relicRetryMs. The plan
    // order is already prioritized (strongest creatures first), so trimming takes the most valuable first.
    // Everything is reversible/free, so an unequip/equip left undone this tick is not a risk.
    const cap = Math.max(1, Number(this.cfg.relicMaxActionsPerTick) || Infinity);
    const totalPlanned = plan.unequip.length + plan.equip.length;
    let budget = cap;
    for (const u of plan.unequip) {
      if (budget-- <= 0 || this.inMaintenance()) break; // stop the moment a mid-tick patch arms — don't cascade local 503s
      try { await this.act('/api/relic/unequip', { relicId: u.relicId }); }
      catch (e) { if (![400, 402, 409].includes(e.status)) this.log('relic unequip err', e.status, (e.bodyText || '').slice(0, 60)); }
    }
    let equipped = 0;
    for (const e of plan.equip) {
      if (budget-- <= 0 || this.inMaintenance()) break; // ditto — a 503 here means the server went down mid-tick
      try {
        await this.act('/api/relic/equip', { relicId: e.relicId, target: e.target, slot: e.slot });
        equipped++;
        this.recordEvent('relic_equip', { ref: { relicId: e.relicId, target: e.target, slot: e.slot } });
      } catch (err) {
        if (![400, 402, 409].includes(err.status)) this.log('relic equip err', err.status, (err.bodyText || '').slice(0, 60));
      }
    }
    if (equipped) this.log(`RELICS equipped ${equipped}/${plan.equip.length} (party_power ↑)`);
    if (totalPlanned > cap) this.log(`RELICS batch-capped ${cap}/${totalPlanned} — the rest on the next cycle`);
  }

  // Trainer relics: a SEPARATE system from pet relics (class≠'combat', one carrier — the trainer itself,
  // 3 fixed slots amulet/ring/idol). An independent periodic optimizer (the same principle as handleRelics):
  // compares ALL owned trainer relics by stats, equips the best in each slot.
  // Previously the only "equip" point was right inside handleForgeTrainerRelic — it blindly equipped the
  // just-forged relic, never comparing it to the one already worn (it could even WORSEN the gear).
  // Money-safe: equip/unequip are free and reversible, the server rejects invalid ones (400/402/409).
  async handleTrainerRelics(state) {
    const now = Date.now();
    if (now < this.nextTrainerRelicAt) return;
    this.nextTrainerRelicAt = now + this.cfg.trainerRelicRetryMs;
    const relics = state.relics || [];
    if (relics.length === 0) return;
    const plan = planTrainerRelicEquip(relics, {
      weights: this.cfg.relicStatWeights,
      trainerClass: this.cfg.forgeRelicClass || 'trainer',
    });
    for (const u of plan.unequip) {
      try { await this.act('/api/relic/unequip', { relicId: u.relicId }); }
      catch (e) { if (![400, 402, 409].includes(e.status)) this.log('trainer relic unequip err', e.status, (e.bodyText || '').slice(0, 60)); }
    }
    let equipped = 0;
    let firstReject = null;
    for (const e of plan.equip) {
      try {
        await this.act('/api/relic/equip', { relicId: e.relicId, slot: e.slot });
        equipped++;
        this.recordEvent('trainer_relic_equip', { ref: { relicId: e.relicId, slot: e.slot } });
        this.log(`TRAINER RELIC equipped ${e.slot}`);
      } catch (err) {
        if (!firstReject) firstReject = `${err.status} ${(err.bodyText || err.message || '').slice(0, 120)} (slot=${e.slot})`;
        if (![400, 402, 409].includes(err.status)) this.log('trainer relic equip err', err.status, (err.bodyText || '').slice(0, 60));
      }
    }
    // 2026-07-06: "attempted 2, 0 accepted" on main/spare for no reason — the equip shape for the trainer
    // class is unconfirmed (may require target/a different endpoint); we print the FIRST rejection body so
    // we don't guess. Throttled by trainerRelicRetryMs (10 min).
    if (!equipped && plan.equip.length) this.log(`TRAINER RELICS attempted ${plan.equip.length}, 0 accepted — first reject: ${firstReject}`);
  }

  // Relic Forge (2026-07-03 update): enhancing WORN relics for Gold + materials raises their affixes →
  // party_power ↑ → deeper dungeons → more Gold. The same money-safe tier as evolve/breeding (Gold+materials
  // only, no Gems/signature). We only enhance the worn ones (on unequipped it's wasted spend).
  // "Not ripe yet / no Gold-materials / already MAX" = 400/402/409 — expected, silent. Throttled.
  async handleRelicEnhance(state) {
    if (!this.cfg.autoEnhanceRelics) return;
    const now = Date.now();
    if (now < this.nextEnhanceAt) return;
    this.nextEnhanceAt = now + this.cfg.enhanceRetryMs;
    const p = state.player || {};
    if ((p.gold ?? 0) <= this.cfg.minGoldReserve) return;
    if ((p.gold ?? 0) < (Number(this.cfg.enhanceMinGold) || 0)) return; // protect the egg/breed budget (modeled on forgeMinGold)
    const classes = Array.isArray(this.cfg.enhanceRelicClasses) ? this.cfg.enhanceRelicClasses : null;
    const maxLevel = this.cfg.enhanceMaxLevel ?? Infinity;
    // "worn" = equipped_on OR equip_slot: trainer relics mark equipping via equip_slot without equipped_on
    // (the carrier is the trainer, not a creature) — the old filter didn't see them at all.
    const equipped = (state.relics || []).filter(r =>
      (r.equipped_on != null || r.equip_slot != null) && !r.listed && !r.stored
      && (!classes || classes.includes(r.class))
      && (Number(r.enhance_level) || 0) < maxLevel);
    // the order of strongest carriers doesn't matter — we enhance one relic per pass, preferring fresh ones (low enhance_level)
    equipped.sort((a, b) => (Number(a.enhance_level) || 0) - (Number(b.enhance_level) || 0));
    for (const relic of equipped) {
      if ((state.player?.gold ?? p.gold ?? 0) <= this.cfg.minGoldReserve) break;
      try {
        await this.act('/api/relic/enhance', { relicId: relic.id });
        this.log(`ENHANCE relic ${String(relic.id).slice(0, 8)} → +${(Number(relic.enhance_level) || 0) + 1}`);
      } catch (e) {
        // 400/402/409 = MAX / not enough Gold-materials — expected, silent
        if (![400, 402, 409].includes(e.status)) this.log('enhance err', e.status, (e.bodyText || '').slice(0, 60));
      }
    }
  }

  // Trainer Relic Forge (Task-2, friend): forge Legendary trainer relics (amulet/ring/idol) → worn on the
  // trainer they speed pet births 2×. ⚠️ Params (relicClass/equip) NOT confirmed live —
  // money-safe: gold is charged only on a successful forge; a wrong relicClass → 400 (no spend).
  // planTrainerForge gate: gold ≥ forgeMinGold (protect egg/breed) + a daily limit + slot rotation.
  async handleForgeTrainerRelic(state) {
    if (!this.cfg.autoForgeTrainerRelic) return;
    const now = Date.now();
    if (now < this.nextForgeAt) return;
    const day = new Date().toISOString().slice(0, 10);
    if (this.forgeDay !== day) { this.forgeDay = day; this.forgesToday = 0; } // reset the daily counter (UTC)
    const plan = planTrainerForge(this.cfg, { gold: state.player?.gold ?? 0, forgesToday: this.forgesToday });
    if (!plan) return;
    this.nextForgeAt = now + this.cfg.forgeRetryMs;
    try {
      const r = await this.act('/api/relic/craft', { relicClass: plan.relicClass, slot: plan.slot });
      this.forgesToday++;
      const relicId = r?.relic?.id ?? r?.id ?? null;
      this.log(`FORGE trainer ${plan.slot} → ${relicId ? String(relicId).slice(0, 8) : 'ok'} (~${plan.costGold}g, ${this.forgesToday}/${this.cfg.forgeDailyCap} today)`);
      this.recordEvent('relic_forge', {
        amounts: plan.costGold ? { gold: -plan.costGold } : {},
        ref: { slot: plan.slot, relicId },
        meta: { relicClass: plan.relicClass, costEstimated: true },
      });
      // We NO LONGER equip here naively (it used to blindly equip the just-forged relic, even if a better
      // one is already worn — a risk of WORSENING the gear). handleTrainerRelics — the independent
      // by-stats optimizer — will pick up the new relic on the next tick itself.
    } catch (e) {
      // 400 wrong relicClass / daily cap · 402 not enough gold-materials · 409 conflict — expected.
      // A 6h backoff so we don't spam the expensive forge on a persistent rejection (e.g. the server's daily cap).
      if (![400, 402, 409].includes(e.status)) this.log('forge err', e.status, (e.bodyText || '').slice(0, 80));
      else this.nextForgeAt = now + 6 * 60 * 60 * 1000;
    }
  }

  // Evolution: raise the stage (×3 power per stage → party_power ↑ → deeper dungeons, more Gold/run).
  // A stage matures on a timer; the server allows evolve(useXp:false) after the timer for Gold, or
  // evolve(useXp:true) — skip the timer for accumulated XP (feeding builds it up). Under objective
  // 'gold-per-run' (unlimited resources) we break the timers via useXp to reach Adult/Elder fast; under
  // 'gold-per-stamina' we wait out the timer (conserve resources). 400/402/409/425 = "not ripe / not enough
  // Gold or XP" — expected, silently skipped; throttled so we don't spam the server.
  async handleEvolve(state) {
    const now = Date.now();
    if (now < this.nextEvolveAt) return;
    this.nextEvolveAt = now + 10 * 60 * 1000; // try no more than once per 10 min
    const p = state.player || {};
    if ((p.gold ?? 0) <= this.cfg.minGoldReserve) return;
    const useXp = this.cfg.depthObjective === 'gold-per-run'; // break the timers with XP for party_power
    // Rarities allowed to evolve Adult→Elder (2026-07-06, friend): everything else caps at Adult (no Gold
    // wasted on Elder + Adult is the breeding stage). null = every rarity may reach Elder (old behavior).
    const elderR = Array.isArray(this.cfg.evolveElderRarities)
      ? new Set(this.cfg.evolveElderRarities.map(r => String(r).toLowerCase()))
      : null;
    // allCreatures (2026-07-06): the vault is a nursery (Baby uncommons parked there for breeding), feeding
    // sees them (also allCreatures), but evolution previously did NOT — a vaulted Baby accumulated XP via
    // feeding and stayed Baby forever. Money-safe: if the server rejects evolving in the vault — 400/409, silently skip.
    // Sort (2026-07-06, "why do pets stay Baby so long"): (1) the field is called creature_xp, the old
    // `c.xp` doesn't exist → the order was random; (2) YOUNGER stages first — Baby→Juv costs pennies,
    // Adult→Elder is expensive; previously an expensive Adult ended up first, caught a 402 "Not enough Gold",
    // and the break killed the whole cycle — Babies with 10-25× the needed XP sat for 2-3 DAYS.
    const candidates = this.allCreatures(state)
      .filter(c => c.stage !== 'Elder' && !c.quick_evolved && !c.listed) // listed → 409 "Unlist it on the market first"
      // Stop at Adult unless the rarity may reach Elder (see elderR): an Adult of a capped rarity is skipped
      // — it stays Adult for breeding instead of burning Gold on Adult→Elder.
      .filter(c => c.stage !== 'Adult' || !elderR || elderR.has(String(c.rarity || '').toLowerCase()))
      .sort((a, b) => (STAGE_RANK[a.stage] ?? 0) - (STAGE_RANK[b.stage] ?? 0)
        || (b.creature_xp || 0) - (a.creature_xp || 0));
    // Rotation out of the nursery (2026-07-06, live: "409 Withdraw this creature from storage before evolving
    // it" ×24-69 on EVERY account): feeding in the vault the server allows, evolving — NOT. The nursery
    // accumulated XP, but the youngsters were locked as Baby. The valve: a vaulted candidate with spare XP is
    // first withdrawn (store:false), evolution catches it in the same pass as an active pet; ordinary intake
    // returns it to the nursery (priority by pairs/rarity). A per-pass withdrawal limit + a roster-slot
    // reserve — don't squeeze out the dungeon lineup.
    const rosterCap = Number(this.cfg.vaultRosterFull) || 49;
    let activeCount = (state.creatures || []).length;
    let unvaulted = 0;
    const UNVAULT_MAX_PER_PASS = 6;
    let evolved = 0, rejected = 0, firstReject = null;
    for (const cr of candidates) {
      if ((p.gold ?? 0) <= this.cfg.minGoldReserve) break;
      if (cr.stored === true) {
        if (unvaulted >= UNVAULT_MAX_PER_PASS || activeCount >= rosterCap - 1) continue;
        // Anti-loop (2026-07-06, live: 148 pets cycled vault↔unvault up to 11 times/2h): a pet whose evolution
        // was rejected by the server AFTER withdrawal is not withdrawn again for an hour — let it feed up;
        // without a memory of rejections the loop unvault→402→intake→unvault burned move-calls forever.
        if ((this.evolveRejectedAt?.get(cr.id) || 0) > now - 60 * 60 * 1000) continue;
        // Readiness threshold: Baby 5 feeds = 100 XP; Juvenile 13 feeds = 260 XP (friend). It was 250 — a pet
        // with 250-259 XP was withdrawn forever and rejected by the server (10 XP short = the whole loop).
        const needXp = String(cr.stage).toLowerCase() === 'baby' ? 100 : 260;
        if ((Number(cr.creature_xp) || 0) < needXp) continue;
        try {
          await this.act('/api/storage/move', { itemKind: 'creature', itemId: cr.id, store: false });
          unvaulted++; activeCount++;
          this.log(`UNVAULT ${cr.species || cr.creature_id || cr.id.slice(0, 6)} ${cr.stage} xp=${cr.creature_xp ?? '?'} → to the yard for evolution`);
          this.recordEvent('creature_unvault', { ref: { creatureId: cr.id }, meta: { reason: 'evolve', stage: cr.stage } });
        } catch (e) {
          if (![400, 404, 409].includes(e.status)) this.log('unvault err', e.status || '', (e.bodyText || e.message || '').slice(0, 60));
          continue; // didn't withdraw — don't try evolving (a guaranteed 409)
        }
      }
      try {
        await this.act('/api/creature/evolve', { creatureId: cr.id, useXp });
        evolved++;
        this.log(`EVOLVE ${cr.species || cr.creature_id || cr.id.slice(0, 6)} ${cr.stage}→next`);
        this.recordEvent('creature_evolve', { ref: { creatureId: cr.id }, meta: { from: cr.stage, useXp } }); // 2026-07-06: evolution was invisible to the ledger — "Baby for weeks" couldn't be told apart from "evolve isn't called"
      } catch (e) {
        // 400/402/409/425 = not ripe yet / not enough Gold or XP; 404 = the creature vanished between the
        // snapshot and the call (sold/sacrificed in this same tick) — expected, BUT the reason should be
        // visible: 2026-07-06 youngsters sat Baby for 2-3 DAYS, and a full swallow hid the server's rejection.
        rejected++;
        // rejection memory for the unvault anti-loop (see above): especially important for just-withdrawn ones
        if (!this.evolveRejectedAt) this.evolveRejectedAt = new Map();
        this.evolveRejectedAt.set(cr.id, now);
        if (this.evolveRejectedAt.size > 400) { // don't grow the Map unbounded
          for (const [id, t] of this.evolveRejectedAt) if (t < now - 2 * 60 * 60 * 1000) this.evolveRejectedAt.delete(id);
        }
        if (!firstReject) firstReject = `${e.status} ${(e.bodyText || e.message || '').slice(0, 120)} (${cr.creature_id || ''} ${cr.stage} xp=${cr.creature_xp ?? '?'} stored=${!!cr.stored})`;
        if (![400, 402, 404, 409, 425].includes(e.status)) this.log('evolve err', e.status ?? '', (e.bodyText || e.message || '').slice(0, 70));
        // 402 is NO LONGER a break (2026-07-06): "not enough Gold" refers to THIS (expensive) candidate,
        // the next one may be cheaper — the cost grows with the stage, it's not one for all.
      }
    }
    if (rejected && !evolved) this.log(`evolve skip: ${rejected} rejects, first: ${firstReject}`); // throttled itself (nextEvolveAt 10m)
  }

  // Cashout: sell surplus Gold → $ZOLANA on the market once the account has "run the strategy to the end"
  // (depth ceiling reached/plateaued). Opt-in (autoSellGold). Seller-passive: we POST a listing, sign
  // nothing — $ZOLANA lands on the wallet when a live buyer buys. Human: a cooldown between listings + a
  // non-round partial lot + a price jittered around the live floor.
  // Revenue consolidation — separately, via the ready-made scripts/sweep-funds.js.
  async handleCashout(state) {
    if (!this.cfg.autoSellGold && !this.cfg.autoSellJunk) return;
    const now = Date.now();

    // 0) one-per-process preflight — confirm the live API shapes at startup
    if (!marketPreflightDone) { marketPreflightDone = true; await this.marketPreflight(); }

    // 1) record in the ledger any sales (gold/creatures/relics) that closed since the last check → market_sale
    try {
      const sales = await getMySales(this.c);
      const newSales = newlySold(this.soldMarketIds, sales);
      for (const s of newSales) {
        this.soldMarketIds.add(s.id);
        const { amounts, usd, kind, buyer } = saleLedgerAmounts(s, this.priceUsd);
        // Rarity + traits of what sold (species/variant) — for the sales log (owner 2026-07-06). Stored in
        // the ledger meta so the dashboard can render them; null for fungible gold. Old sales (pre-this-
        // change) simply have no rarity/variant → shown as "—".
        const { rarity, variant, species } = marketTraitsOf(s);
        this.recordEvent('market_sale', {
          // itemId (the creature id) is stable across reprices and is the reliable backfill key — the
          // listingId changes on every reprice (and can be null), so the sales-log rarity backfill keys on
          // itemId → the traits WE recorded when listing it (2026-07-06: reprices broke listingId matching).
          amounts, ref: { listingId: s.id, itemId: s.item_id ?? null, itemKind: kind, buyer },
          meta: { priceUsd: usd, buyer, rarity, variant, species },
        });
        const qty = kind === 'gold' ? ` ${s.quantity}` : ` ${String(s.item_id ?? s.id).slice(0, 8)}`;
        // e.g. "SOLD creature a1b2c3d4 [smoldra uncommon ✦rainbow] for $0.2 (~120 Z) to 2zzz…"
        const traits = [species, rarity, (variant && variant !== 'normal') ? `✦${variant}` : null].filter(Boolean).join(' ');
        const traitsStr = traits ? ` [${traits}]` : '';
        const toWhom = buyer ? ` to ${String(buyer).slice(0, 8)}…` : '';
        this.log(`SOLD ${kind}${qty}${traitsStr} for $${usd} (~${Math.round(amounts.zolana)} Z)${toWhom}`);
      }
      // 2026-07-06: persist AFTER processing the batch (not once per sale) — survives a process restart,
      // otherwise the next tick after ANY restart (frequent under --watch) sees these same IDs as "new"
      // again and doubles market_sale in the ledger (found: 15x inflation, growing with every restart).
      if (newSales.length) this.saveSoldMarketIds();
    } catch (e) { this.log('cashout sales-read err', e.status || '', (e.message || '').slice(0, 60)); }

    if (this.cfg.ledger) await this.syncActiveMarketListings(now);

    // unlist creatures once if creature selling is off (we switched to recycling into XP)
    if (!this.cfg.autoSellJunkCreatures && !this.creatureUnlistDone) {
      this.creatureUnlistDone = true;
      await this.unlistCreatureListings();
    }

    // 2) start gate: either the account is "scaled up" (isDoneScaling), or selling during scaling is
    //    explicitly allowed (autoSellDuringScaling) — then we pull tokens right away.
    if (!this.cfg.autoSellDuringScaling
      && !isDoneScaling({ ceiling: this.depthCeiling, ceilingStableTicks: this.ceilingStableTicks, cfg: this.cfg })) return;
    if (now < this.nextCashoutAt) return;
    if (!this.hasMarketSellAccess(state)) {
      this.log(`cashout skip: ZOLANA ${state.player?.zenko_balance ?? 0} < market sell gate ${this.cfg.marketSellMinZolana}`);
      return;
    }

    // keep existing listings "at market" always — including after reaching the goal.
    if (await this.tryRepriceMarketListing(now)) return;

    // 3) upper target: reached the ZOLANA goal on the wallet → don't put out new lots
    //    (existing ones remain and keep selling; the reprice above keeps them at market).
    if (!this.belowZolanaTarget(state)) return;

    for (const lane of this.cashoutLaneOrder()) {
      if (lane === 'gold' && await this.tryListGold(state, now)) return;
      if (lane === 'creature' && await this.tryListCreature(state, now)) return;
    }

    if (this.cfg.autoSellJunk) await this.handleJunkLiquidation(state, now);
  }

  // Read-only check of the live market shapes: confirms the parser sees the needed fields.
  // Never writes or signs. Logs one PREFLIGHT line + a WARN on a mismatch.
  async marketPreflight() {
    try {
      const rows = parseListings(await this.c.api('/api/market/browse?kind=gold'));
      const hasSeller = rows.some((r) => r.seller != null);
      const floor = goldFloorUsd(rows, { fleetWallets: this.cfg.fleetWallets });
      const sales = await getMySales(this.c).catch(() => []);
      const hasBuyer = Array.isArray(sales) && sales.some((s) => (s?.buyer ?? s?.buyer_wallet) != null);
      const buyerState = !sales.length ? 'n/a (no sales yet)' : hasBuyer ? 'yes' : 'NO';
      this.log(`PREFLIGHT market: browse=${rows.length} seller=${hasSeller ? 'yes' : 'NO'} goldFloor=${floor == null ? 'n/a' : floor} sales=${sales.length} buyer=${buyerState}`);
      if (rows.length && !hasSeller) this.log('PREFLIGHT WARN: no seller field in browse → the fleet-exclusion is inert (self-dump risk again); verify the field name');
    } catch (e) {
      this.log('PREFLIGHT market err', e.status || '', (e.message || '').slice(0, 60));
    }
  }

  // Upper stop: sell while the wallet holds less than the target ZOLANA reserve.
  // cashoutTargetZolana not set (Infinity/0) ⇒ no limit.
  belowZolanaTarget(state) {
    const target = Number(this.cfg.cashoutTargetZolana);
    if (!Number.isFinite(target) || target <= 0) return true;
    const held = Number(state?.player?.zenko_balance ?? state?.player?.zolana ?? 0) || 0;
    return held < target;
  }

  cashoutLaneOrder() {
    const first = chooseCashoutLane({ rng: this.rng, cfg: this.cfg });
    const base = ['gold', 'creature'];
    if (!first) return [];
    return [first, ...base.filter(lane => lane !== first)];
  }

  hasMarketSellAccess(state) {
    const min = Math.max(0, Number(this.cfg.marketSellMinZolana ?? 0) || 0);
    if (!min) return true;
    return (Number(state?.player?.zenko_balance ?? state?.player?.zolana ?? 0) || 0) >= min;
  }

  async syncActiveMarketListings(now = Date.now()) {
    let active = [];
    try {
      active = (await getMyListings(this.c)).filter(row => isActiveListing(row) && String(row.currency || 'zenko').toLowerCase() !== 'gems');
    } catch (e) {
      this.log('cashout sync-listings err', e.status || '', (e.message || '').slice(0, 60));
      return false;
    }

    const open = openMarketListingsFromEvents(this.loadLedgerEvents());
    let synced = 0;
    for (const listing of active) {
      if (!listing.id || open.has(listing.id)) continue;
      this.recordEvent('market_sync', {
        ts: new Date(now).toISOString(),
        ref: { listingId: listing.id, itemKind: listing.itemKind, itemId: listing.itemId },
        meta: {
          priceUsd: listing.priceUsd,
          currency: listing.currency || 'zenko',
          synced: true,
        },
      });
      synced++;
    }
    if (synced) this.log(`cashout synced ${synced} active market listing(s)`);
    return synced > 0;
  }

  async floorForListing(listing) {
    const kind = String(listing?.itemKind || '').toLowerCase();
    const opts = { fleetWallets: this.cfg.fleetWallets };
    if (kind === 'gold') return getGoldFloorUsd(this.c, opts);
    if (!kind) return null;
    return getMarketFloorUsd(this.c, kind, opts);
  }

  async tryRepriceMarketListing(now = Date.now()) {
    if (!this.cfg.cashoutRepriceEnabled) return false;
    let active = [];
    try {
      active = (await getMyListings(this.c)).filter(row => isActiveListing(row) && String(row.currency || 'zenko').toLowerCase() !== 'gems');
    } catch (e) {
      this.log('cashout reprice-listings err', e.status || '', (e.message || '').slice(0, 60));
      return false;
    }

    for (const listing of active) {
      const listKind = String(listing?.itemKind || '').toLowerCase();
      const listTraits = listKind === 'creature' ? marketTraitsOf(listing) : {};
      let floorUsd = null;
      if (listKind === 'creature' && listTraits.rarity) {
        // Rarity-aware floor (real per-rarity sales → seed), SAME source as the fresh-listing path — not
        // the rarity-BLIND getMarketFloorUsd (cheapest creature of any rarity) that dragged an uncommon
        // toward the common floor. planListingReprice clamps the decay at this, so the lot settles at its
        // rarity's demand level instead of sliding to $0.01. Fall back to the generic floor only if the
        // listing row carries no rarity (then the clamp is at least the market min, still > $0.01 → not a dump).
        floorUsd = creatureFloorUsdForRarity(listTraits.rarity, this.creatureFloorZolana, this.priceUsd, listTraits.variant);
      }
      if (!(floorUsd > 0)) { try { floorUsd = await this.floorForListing(listing); } catch { continue; } }
      const plan = planListingReprice({ listing, floorUsd, now, cfg: this.cfg });
      if (!plan) continue;
      if (plan.itemKind !== 'gold' && !plan.itemId) continue;

      this.nextCashoutAt = now + this.rand(this.cfg.cashoutListCooldownMinMs, this.cfg.cashoutListCooldownMaxMs);
      try {
        await cancelListing(this.c, plan.listingId);
        this.recordEvent('market_cancel', {
          ref: { listingId: plan.listingId, itemKind: plan.itemKind, itemId: plan.itemId },
          meta: { reason: 'reprice', oldPriceUsd: plan.oldPriceUsd, newPriceUsd: plan.newPriceUsd, currency: 'zenko' },
        });

        const res = plan.itemKind === 'gold'
          ? await listGold(this.c, { quantity: plan.quantity, priceUsd: plan.newPriceUsd })
          : await listMarketItem(this.c, { itemKind: plan.itemKind, itemId: plan.itemId, priceUsd: plan.newPriceUsd });
        this.recordEvent('market_list', {
          ref: { listingId: res?.id ?? null, itemKind: plan.itemKind, itemId: plan.itemId, repriceFrom: plan.listingId },
          // ...listTraits (rarity/variant/species) so the sales log can show what sold even for a REPRICED
          // listing — the reprice used to drop these, so a repriced-then-sold pet showed rarity "—" (owner).
          meta: { priceUsd: plan.newPriceUsd, oldPriceUsd: plan.oldPriceUsd, floorUsd, currency: 'zenko', reprice: true, ...listTraits },
        });
        this.log(`REPRICE ${plan.itemKind} ${plan.listingId} $${plan.oldPriceUsd} -> $${plan.newPriceUsd}`);
        return true;
      } catch (e) {
        this.log('cashout reprice err', e.status || '', (e.bodyText || e.message || '').slice(0, 80));
        return false;
      }
    }
    return false;
  }

  async tryListGold(state, now = Date.now()) {
    if (!this.cfg.autoSellGold) return false;
    const gold = state.player?.gold ?? 0;
    // Hysteresis (owner 2026-07-06): while NOT armed — wait for accumulation up to cashoutGoldSellTrigger
    // before even trying to sell (not immediately on the first surplus > minLot). We disarm again below when
    // the surplus depletes to the reserve — the next sell cycle waits for a NEW full set up to the trigger,
    // rather than resuming on the first random gold increase above a narrow threshold.
    const trigger = Number(this.cfg.cashoutGoldSellTrigger);
    const hysteresisOn = Number.isFinite(trigger) && trigger > 0;
    if (hysteresisOn && !this.goldSellArmed) {
      if (gold < trigger) return false;
      this.goldSellArmed = true;
    }
    const surplus = gold - this.cfg.cashoutGoldReserve;
    if (surplus < this.cfg.cashoutMinLotGold) {
      if (hysteresisOn) this.goldSellArmed = false;
      return false;
    }

    const maxActive = Number(this.cfg.cashoutMaxActiveListings);
    if (Number.isFinite(maxActive) && maxActive >= 0) {
      try {
        const activeGoldListings = activeListingCount(await getMyGoldListings(this.c), { itemKind: 'gold', currency: 'zenko' });
        if (activeGoldListings >= maxActive) {
          this.log(`cashout skip: ${activeGoldListings} active gold listings >= cap ${maxActive}`);
          return false;
        }
      } catch (e) {
        this.log('cashout listings-read err', e.status || '', (e.message || '').slice(0, 60));
        return false;
      }
    }

    let floorUsd = null;
    try { floorUsd = await getGoldFloorUsd(this.c, { fleetWallets: this.cfg.fleetWallets }); } catch { return false; }
    const plan = planGoldListing({ surplus, floorUsd, rng: this.rng, cfg: this.cfg });
    if (!plan) return false;

    this.nextCashoutAt = now + this.rand(this.cfg.cashoutListCooldownMinMs, this.cfg.cashoutListCooldownMaxMs);
    try {
      const res = await listGold(this.c, plan);
      this.recordEvent('market_list', {
        amounts: { gold: -plan.quantity },
        ref: { listingId: res?.id ?? null }, meta: { priceUsd: plan.priceUsd, currency: 'zenko' },
      });
      this.log(`LIST gold ${plan.quantity} @ $${plan.priceUsd} (floor $${floorUsd?.toFixed(8)})`);
      return true;
    } catch (e) {
      this.log('cashout list err', e.status || '', (e.bodyText || e.message || '').slice(0, 80));
      return false;
    }
  }

  async tryListCreature(state, now = Date.now()) {
    if (!this.cfg.autoSellJunk || !this.cfg.autoSellJunkCreatures) return false;
    const creature = pickJunkCreatures(state.creatures || [], { ...this.cfg, busyIds: this.busyIds(state) })[0];
    if (!creature) return false;

    const maxActive = Number(this.cfg.cashoutMaxActiveCreatureListings ?? this.cfg.cashoutMaxActiveListings);
    if (Number.isFinite(maxActive) && maxActive >= 0) {
      try {
        const activeCreatureListings = activeListingCount(await getMyListings(this.c, { itemKind: 'creature' }), { itemKind: 'creature', currency: 'zenko' });
        if (activeCreatureListings >= maxActive) {
          this.log(`cashout skip: ${activeCreatureListings} active creature listings >= cap ${maxActive}`);
          return false;
        }
      } catch (e) {
        this.log('cashout creature-listings-read err', e.status || '', (e.message || '').slice(0, 60));
        return false;
      }
    }

    return this.listJunkItem('creature', creature, now);
  }

  // Breeding: a best-effort pair — two most levelled Adult+ of one species, not busy in a run.
  // The exact parent-compatibility rules (same-element/hybrid ladders per the wiki) aren't given to us by
  // the server — an invalid pair is simply rejected by the server (400/402/409), handled as silently as evolve/dungeon.
  async handleJunkLiquidation(state, now = Date.now()) {
    // Random skip of a listing attempt: accounts don't list on a schedule (not clockwork) but chaotically —
    // like independent sellers. On a skip — a short re-schedule (1min…cooldownMin), not a full cooldown, so
    // the pace holds on average but the listing moment is unpredictable (see Task-1).
    const chance = Number(this.cfg.cashoutListChance);
    if (Number.isFinite(chance) && chance < 1 && this.rng() > chance) {
      this.nextCashoutAt = now + this.rand(60 * 1000, this.cfg.cashoutListCooldownMinMs);
      return false;
    }
    if (this.cfg.autoSellJunkRelics) {
      const relic = pickJunkRelics(state.relics || [], this.cfg)[0];
      if (relic && await this.listJunkItem('relic', relic, now)) return true;
    }
    if (this.cfg.autoSellJunkCreatures) {
      const creature = pickJunkCreatures(state.creatures || [], { ...this.cfg, busyIds: this.busyIds(state) })[0];
      if (creature && await this.listJunkItem('creature', creature, now)) return true;
    }
    return false;
  }

  async listJunkItem(itemKind, item, now = Date.now()) {
    let floorUsd = null;
    if (itemKind === 'creature') {
      // Rarity-aware: getMarketFloorUsd('creature') ignores rarity (min price among ANY creature lot on the
      // market) — a Rare was actually listed at the price of the cheapest Common/Uncommon.
      // creatureFloorUsdForRarity takes: an explicit (rarity,variant) override (2026-07-06, e.g. rainbow),
      // otherwise the live per-rarity floor (real sales), otherwise a rarity-seed (see CREATURE_FLOOR_SEED_USD)
      // — with no data from either, we skip the listing rather than guess the price.
      floorUsd = creatureFloorUsdForRarity(item?.rarity, this.creatureFloorZolana, this.priceUsd, item?.variant);
    } else {
      try { floorUsd = await getMarketFloorUsd(this.c, itemKind, { fleetWallets: this.cfg.fleetWallets }); } catch { return false; }
    }
    if (!(floorUsd > 0)) return false;
    // Creatures: we CLUSTER the price around the external floor with a symmetric random jitter
    // ±cashoutPriceJitterPct (planOrganicPrice) → the fleet looks like many independent sellers at +- one
    // clear price, NOT one seller with a floor−ε wall (a tell + a self-dump spiral).
    // Our own listings aren't in the floor (fleetWallets). Relics — via the previous planUniqueFloorListing.
    let priceUsd;
    let priceSource = null;
    if (itemKind === 'creature' && this.cfg.cashoutDemandPricing) {
      // Ideal price parsed SPECIES-first (2026-07-06, owner: "the ideal price should be parsed from the
      // market metrics of every pet species"): creatureIdealPriceUsd walks species clearing (median of THIS
      // species' real sales, collected with the floor once per 10 min) → its lowest external ask → the same
      // at rarity granularity (previous behavior) → the seed floor. Never undercuts our own fleet ask. One
      // browse call per listing feeds the live ask signals (human cadence via the cooldown below).
      let listingRows = [];
      try { listingRows = parseListings(await this.c.api('/api/market/browse?kind=creature')); }
      catch { /* browse unavailable — ask signals just empty; clearing/floor still price it */ }
      const mkOpts = { fleetWallets: this.cfg.fleetWallets };
      const ideal = creatureIdealPriceUsd({
        species: item?.species ?? item?.creature_id,
        rarity: item?.rarity,
        variant: item?.variant,
        metricsBySpecies: this.creatureMetricsBySpecies || {},
        asksBySpecies: creatureAsksBySpecies(listingRows, mkOpts),
        clearingUsdByRarity: this.creatureClearingUsd || {},
        clearingCountByRarity: this.creatureSalesCount || {}, // thin-data guard: don't trust a 1-sale median
        variantFloorUsd: this.creatureVariantFloor || {},     // per-trait floor → special variants priced on their own trait
        asksByRarity: creatureAsksByRarity(listingRows, mkOpts),
        floorZolanaByRarity: this.creatureFloorZolana || {},
        zolanaPriceUsd: this.priceUsd,
        cfg: this.cfg,
        rng: this.rng,
      });
      if (!ideal) return false;
      priceUsd = ideal.priceUsd;
      priceSource = ideal.source;
    } else if (itemKind === 'creature') {
      const plan = planOrganicPrice({
        floorUsd,
        jitterPct: this.cfg.cashoutPriceJitterPct,
        undercutMin: this.cfg.cashoutUndercutPctMin,
        undercutMax: this.cfg.cashoutUndercutPctMax,
        minPriceUsd: this.cfg.cashoutMinPriceUsd,
        rng: this.rng,
      });
      if (!plan) return false;
      priceUsd = plan.priceUsd;
    } else {
      const plan = planUniqueFloorListing({ floorUsd, cfg: this.cfg });
      if (!plan) return false;
      priceUsd = plan.priceUsd;
    }
    // Adaptive pace (2026-07-06, owner: "chaotically, at the pace the market needs"): the next listing's
    // cooldown — from the market pulse (sales/hour of external sellers), not a fixed window. The market buys
    // 6/hour → a fleet of N sellers lists so as to take ~sharePct of demand. Without a speed signal — the old random window.
    if (this.cfg.cashoutAdaptivePacing && this.marketVelocity) {
      this.nextCashoutAt = now + planListingPace({
        perHour: this.marketVelocity.perHour,
        sellers: this.cfg.cashoutFleetSellers,
        sharePct: this.cfg.cashoutMarketSharePct,
        minMs: this.cfg.cashoutListCooldownMinMs,
        maxMs: this.cfg.cashoutPacingMaxMs,
        rng: this.rng,
      });
    } else {
      this.nextCashoutAt = now + this.rand(this.cfg.cashoutListCooldownMinMs, this.cfg.cashoutListCooldownMaxMs);
    }
    try {
      let res;
      try {
        res = await listMarketItem(this.c, { itemKind, itemId: item.id, priceUsd });
      } catch (e) {
        // 2026-07-06 live: 409 "Take the creature off your island before listing" — place-auto parked the
        // pet AFTER the tick snapshot (pickJunkCreatures checked placed against stale data). Unplace from the
        // plot and retry once; other errors — out as before.
        if (itemKind === 'creature' && e.status === 409 && /island/i.test(e.bodyText || '')) {
          await this.act('/api/creature/place', { creatureId: item.id, unplace: true });
          res = await listMarketItem(this.c, { itemKind, itemId: item.id, priceUsd });
        } else throw e;
      }
      // Record the listed item's rarity/traits (we OWN it, so we know them for certain). The sales log
      // backfills a sale's rarity from its listing by listingId — this works regardless of whether the
      // my-sales API returns rarity on the sale record (the reliable source for "what sold").
      const listTraits = itemKind === 'creature' ? marketTraitsOf(item) : {};
      this.recordEvent('market_list', {
        ref: { listingId: res?.id ?? null, itemKind, itemId: item.id },
        meta: { priceUsd, floorUsd, currency: 'zenko', ...listTraits },
      });
      const pct = itemKind === 'creature' && floorUsd > 0 ? ` ${priceUsd >= floorUsd ? '+' : '−'}${Math.abs(Math.round((priceUsd / floorUsd - 1) * 1000) / 10)}%` : '';
      const via = priceSource ? ` via ${priceSource}` : ''; // which pricing rung fired (species-clearing / rarity-clearing / seed / …)
      this.log(`LIST ${itemKind} ${String(item.id).slice(0, 8)} @ $${priceUsd} (floor $${floorUsd > 0 ? floorUsd.toFixed(2) : '?'}${pct}${via})`);
      return true;
    } catch (e) {
      this.log('cashout junk-list err', e.status || '', (e.bodyText || e.message || '').slice(0, 80));
      return false;
    }
  }

  // Tier-climb breeding. planBreedPair takes a same-species Adult+ pair with full gates
  // (breed_count<8, cooldown 25m, happiness≥50, not busy/fav/listed, rarity ≤ breedMaxRarity) —
  // same-species guarantees a valid element AND tier, the server deterministically gives the next step.
  // We take the least valuable parents as runners (low stage/level), preferring a rarer pair (higher climb
  // tier). We estimate the cost by min-rarity (≈tier) and track it in the ledger.
  async handleBreed(state) {
    const now = Date.now();
    if (now < this.nextBreedAt) return;
    this.nextBreedAt = now + this.cfg.breedRetryMs;
    const p = state.player || {};
    const reserve = this.cfg.breedGoldReserve ?? this.cfg.minGoldReserve ?? 0;
    if ((p.gold ?? 0) <= reserve) { this.breedSkipLog(`gold ${p.gold ?? 0} <= reserve ${reserve}`); return; }
    // Incubator valve: while there are already breedMaxPendingEggs+ uncooked breeding eggs — don't spawn new
    // ones, let the queue drain. (2026-07-06: there are no more purchased eggs, the farm profile raised the
    // cap to all 6 incubator slots; the valve is still needed — breeding produces eggs faster than the
    // incubator cooks them: 30m–4h per breeding egg.)
    const cap = Number(this.cfg.breedMaxPendingEggs);
    let pendingBreedingEggs = (state.eggs || []).filter(e => e.egg_type === 'breeding' && e.status !== 'hatched').length;
    if (Number.isFinite(cap) && pendingBreedingEggs >= cap) {
      this.breedSkipLog(`incubator pressure: ${pendingBreedingEggs} pending breeding eggs >= cap ${cap}`);
      return;
    }

    // dungeonBusyIds (not busyIds!) — a vaulted pet is NOT busy in a dungeon but CAN breed
    // (breedAllowStored). If we took the whole busyIds() (which includes stored), planBreedPair would cut
    // vaulted ones off before the isBreedEligible check — the "breed from the vault" fix would become dead
    // code. Multi-breed 2026-07-06: up to breedMaxPerTick pairs per call — a pool of 10 breeders in the vault
    // gives up to 5 ready pairs, and one attempt per breedRetryMs left the rest idle. Used parents are added
    // to busyIds so planBreedPair finds the NEXT pair each time; gold and the incubator cap are recomputed
    // between pairs (we don't drop below the reserve in the loop).
    const busyIds = new Set(this.dungeonBusyIds(state));
    const maxPairs = Math.max(1, Number(this.cfg.breedMaxPerTick) || 1);
    let goldLeft = p.gold ?? 0;
    let bred = 0;
    for (let i = 0; i < maxPairs; i++) {
      if (Number.isFinite(cap) && pendingBreedingEggs >= cap) break;
      // allCreatures (not state.creatures!) — vaulted-for-breeding creatures live ONLY in
      // state.stored.creatures (see the comment on allCreatures()); without this planBreedPair could never
      // pick a vaulted one as a partner — the whole "breeding in the vault" bred nothing at all.
      const plan = planBreedPair(this.allCreatures(state), { ...this.cfg, busyIds }, now);
      if (!plan) {
        // Diagnostics 2026-07-05: previously "no plan" was fully silent — during a live investigation
        // ("breeding silent for 4 hours") it was impossible to tell "no pair" from "a pair exists but
        // happiness/cooldown (invisible in the dashboard snapshot) blocks it". describeBreedSkip prints the
        // reason per member of the largest group, if one exists at all. We log only if we bred nothing.
        if (!bred) {
          const detail = describeBreedSkip(this.allCreatures(state), { ...this.cfg, busyIds }, now);
          this.breedSkipLog(detail ? `no eligible pair — ${detail}` : 'no species has 2+ creatures at all');
        }
        break;
      }
      // don't drop below the reserve: if the estimated price is known and Gold doesn't cover reserve+cost — wait
      if (plan.estCostGold != null && goldLeft < reserve + plan.estCostGold) {
        if (!bred) this.breedSkipLog(`gold ${goldLeft} < reserve+cost ${reserve + plan.estCostGold} for ${plan.species}`);
        break;
      }

      const [a, b] = plan.pair;
      busyIds.add(a.id); busyIds.add(b.id); // parents busy until the end of the tick — don't reuse in the next pair
      try {
        const r = await this.act('/api/breed', { parentA: a.id, parentB: b.id, blessed: this.cfg.breedBlessed });
        const ok = r?.bredSuccess !== false; // the server returns bredSuccess; a missing field we treat as accepted
        bred++;
        this.log(`BREED ${plan.species} (${plan.minRarity}${plan.pairUnbound ? ',sellable' : ',bound'}) x2 -> ${ok ? 'success' : 'fail'} (~${plan.estCostGold ?? '?'}g)`);
        // Price: the server doesn't return it in the response — we estimate by min-rarity as a tier proxy. A
        // failed breed refunds 50% Gold (see reference-breeding-feeding-mechanics), so we charge the full
        // price on success and half on failure. costEstimated:true — the number is approximate.
        let goldDelta = 0;
        if (plan.estCostGold != null) goldDelta = ok ? -plan.estCostGold : -Math.round(plan.estCostGold * 0.5);
        goldLeft += goldDelta;
        if (ok) pendingBreedingEggs++; // success = a new breeding egg in the incubator queue
        this.recordEvent('breed', {
          amounts: goldDelta ? { gold: goldDelta } : {},
          ref: { parentA: a.id, parentB: b.id, species: plan.species, blessed: this.cfg.breedBlessed },
          meta: { bredSuccess: r?.bredSuccess ?? null, minRarity: plan.minRarity, costEstimated: plan.estCostGold != null },
        });
      } catch (e) {
        // Previously 400/402/409 were FULLY silent (no log, no ledger) — if the server steadily rejected a
        // seemingly valid pair (e.g. a wrong element-compatibility assumption) it was impossible to see. Now
        // it's visible via the same throttled skip-log (we don't spam it on every attempt).
        if (![400, 402, 409].includes(e.status)) this.log('breed err', e.status, (e.bodyText || '').slice(0, 80));
        else this.breedSkipLog(`api ${e.status} for ${plan.species}: ${(e.bodyText || '').slice(0, 100)}`);
        break; // API error — don't try the next pairs this tick, the cause is likely common
      }
    }
  }

  // Throttled log of the breed-skip reason (about once per 5 min) — the same pattern as recycleSkipLog.
  breedSkipLog(reason) {
    const now = Date.now();
    if (now < (this.nextBreedSkipLogAt || 0)) return;
    this.nextBreedSkipLogAt = now + 5 * 60 * 1000;
    this.log(`breed skip: ${reason}`);
  }

  async handleEggs(state) {
    const now = Date.now();
    // incubate everything in the inventory (the server limits the number of slots itself)
    for (const egg of state.eggs.filter(e => e.status === 'inventory')) {
      try { await this.act('/api/egg/incubate', { eggId: egg.id, boost: false }); this.log(`incubate ${egg.egg_type} ${egg.id.slice(0, 8)}`); }
      catch (e) { if (e.status === 400 || e.status === 409) break; else this.log('incubate err', e.status, (e.bodyText || '').slice(0, 80)); break; }
    }
    // hatch the ready ones (throttle gate; squad-full inside → a short retry, recycle/vault free a slot)
    if (now >= this.nextEggHatchAt) await this.hatchReadyEggs(state, now);
    // Buying eggs for Gold (not real money). Tier progression:
    // <20 pets → basic (2500); ≥20 → elemental for 50k (Rare chance), rotate species.
    // IMPORTANT: state.eggs is ALL eggs over the account's whole life, including already-hatched ones
    // (status:"hatched" records aren't deleted by the server). The gate must look at the PENDING ones
    // (not yet hatched), otherwise after the first 4 eggs buying freezes forever — a bug found 2026-07-02:
    // main/spare both sat on 21-22 "hatched" eggs and autoBuyEggs never fired.
    let pendingEggs = state.eggs.filter(e => e.status !== 'hatched').length;
    if (this.cfg.autoBuyEggs && pendingEggs < this.cfg.eggQueueTarget && now >= this.nextEggBuyAt) {
      // Daily purchase cap (UTC day, modeled on forgeDay/forgesToday). The process restarts often (--watch),
      // so a freshly-created today counter is seeded from the ledger — otherwise every restart would zero it
      // and the cap would be breached. Lazily here (not in the constructor): bots without autoBuyEggs have no
      // reason to load the ledger; at an Infinity cap the counter doesn't matter — we don't read disk either.
      const day = new Date().toISOString().slice(0, 10);
      if (this.eggBuyDay !== day) {
        this.eggBuyDay = day;
        this.eggBuysToday = Number.isFinite(this.cfg.eggBuyDailyCap)
          ? this.loadLedgerEvents().filter(e => e.type === 'egg_buy' && String(e.ts || '').slice(0, 10) === day).length
          : 0;
      }
      let gold = state.player?.gold ?? 0;
      const creatures = (state.creatures || []).length;
      while (pendingEggs < this.cfg.eggQueueTarget) {
        if (this.eggBuysToday >= this.cfg.eggBuyDailyCap) break;
        let type = 'basic';
        if (creatures >= this.cfg.elementalEggAfter) {
          const types = Array.isArray(this.cfg.elementalEggTypes) && this.cfg.elementalEggTypes.length
            ? this.cfg.elementalEggTypes : ELEMENTAL_EGGS;
          type = types[this.elemIdx % types.length];
        }
        const cost = EGG_COST[type] || 2500;
        if (gold < this.cfg.minGoldReserve + cost) break;
        try {
          await this.act('/api/egg/buy', { eggType: type });
          this.log(`buy ${type} egg (${cost} gold)`);
          this.recordEvent('egg_buy', {
            amounts: { gold: -cost },
            ref: { eggType: type },
            meta: { creaturesBefore: creatures },
          });
          if (type !== 'basic') this.elemIdx++; // the next species in the rotation
          gold -= cost;
          pendingEggs++;
          this.eggBuysToday++;
        } catch (e) {
          if (e.status !== 400) this.log('egg buy err', e.status, (e.bodyText || '').slice(0, 70));
          if ([400, 402, 409].includes(e.status)) this.nextEggBuyAt = now + this.cfg.eggBuyRetryMs;
          break;
        }
      }
    }

    // Bootstrap egg-buy for NEW accounts (2026-07-06, owner: "for new accounts, buy 6 eggs at 50k, and
    // later just breed on cooldown"). A brand-new account has no roster to breed from, so it buys a
    // one-time batch of 50k elemental eggs to seed breeding stock, then never buys again — breeding
    // (autoBreed) takes over. Separate from autoBuyEggs (which stays OFF for established accounts).
    // Auto-gated so it never touches an established account: fires only while the roster is small
    // (bootstrapRosterMax — i.e. a new account) AND the account's LIFETIME egg_buy count (from the ledger,
    // so it survives --watch restarts) is below bootstrapEggCount. Established accounts (roster ~50, or a
    // ledger full of past buys) skip it instantly; a fresh account buys exactly bootstrapEggCount 50k eggs
    // across however many ticks Gold allows (it earns Gold from its starter creature's dungeon runs).
    if (this.cfg.bootstrapEggBuy && now >= this.nextEggBuyAt) {
      const roster = (state.creatures || []).length;
      const rosterMax = Number(this.cfg.bootstrapRosterMax ?? 12);
      const targetCount = Math.max(0, Number(this.cfg.bootstrapEggCount ?? 6));
      if (roster < rosterMax && targetCount > 0) {
        // Lifetime egg_buy count — read once from the ledger (cheap: a new account's ledger is tiny), then
        // kept in memory. Established accounts never reach here (roster gate above), so a large ledger is
        // never loaded on this path. Guards against re-buying the batch after a --watch restart.
        if (this.bootstrapEggsBought == null) {
          this.bootstrapEggsBought = this.loadLedgerEvents().filter(e => e.type === 'egg_buy').length;
        }
        const types = Array.isArray(this.cfg.bootstrapEggTypes) && this.cfg.bootstrapEggTypes.length
          ? this.cfg.bootstrapEggTypes : ELEMENTAL_EGGS;
        const reserve = this.cfg.minGoldReserve || 0;
        let gold = state.player?.gold ?? 0;
        // Pace by the incubator queue (eggQueueTarget) so we don't overfill it; the lifetime count is the
        // real stop. A new account has no breeding eggs competing for slots, so its bootstrap eggs cook freely.
        while (this.bootstrapEggsBought < targetCount && pendingEggs < this.cfg.eggQueueTarget) {
          const type = types[this.elemIdx % types.length];
          const cost = EGG_COST[type] || 50000;
          if (gold < reserve + cost) { this.nextEggBuyAt = now + this.cfg.eggBuyRetryMs; break; } // can't afford yet — retry as Gold accrues from dungeons
          try {
            await this.act('/api/egg/buy', { eggType: type });
            this.bootstrapEggsBought++;
            this.log(`BOOTSTRAP buy ${type} egg (${cost} gold) [${this.bootstrapEggsBought}/${targetCount}]`);
            this.recordEvent('egg_buy', { amounts: { gold: -cost }, ref: { eggType: type }, meta: { bootstrap: true, rosterBefore: roster } });
            this.elemIdx++;
            gold -= cost;
            pendingEggs++;
          } catch (e) {
            if (e.status !== 400) this.log('bootstrap egg buy err', e.status, (e.bodyText || '').slice(0, 70));
            if ([400, 402, 409].includes(e.status)) this.nextEggBuyAt = now + this.cfg.eggBuyRetryMs;
            break;
          }
        }
      }
    }
  }

  // Hatch ready eggs. Extracted so it can be called BOTH before dungeons (handleEggs) AND right after
  // recycle/vault freed a roster slot (handleDungeons) — then the freed slot is taken by a hatch on the
  // SAME tick, without a 10-min lag (bug: 23 eggs piled up due to squad-full + a long backoff).
  // squad-full 409 → a short retry (eggHatchSquadFullRetryMs, a slot is about to free up); other errors →
  // the ordinary eggHatchRetryMs. squad-full isn't logged (expected, noisy). Returns {hatched, squadFull}.
  async hatchReadyEggs(state, now = Date.now()) {
    let hatched = 0, squadFull = false;
    for (const egg of state.eggs || []) {
      const ready = egg.status === 'ready' || (egg.status === 'incubating' && egg.hatch_ready_at && parseTime(egg.hatch_ready_at) <= now);
      if (!ready) continue;
      try {
        const r = await this.act('/api/egg/hatch', { eggId: egg.id });
        this.log(`HATCH -> ${r?.creature?.species || 'creature'} (${r?.creature?.rarity || ''} ${r?.creature?.variant || ''})`.trim());
        this.recordEvent('egg_hatch', { ref: { eggId: egg.id }, meta: { species: r?.creature?.species, rarity: r?.creature?.rarity } }); // for the dashboard's flywheel activity strip
        hatched++;
      } catch (e) {
        if (e.status === 409) {
          squadFull = /squad full|sacrifice or vault/i.test(e.bodyText || '');
          this.nextEggHatchAt = now + (squadFull ? (this.cfg.eggHatchSquadFullRetryMs ?? 60_000) : this.cfg.eggHatchRetryMs);
        } else {
          this.log('hatch err', e.status, (e.bodyText || '').slice(0, 80));
        }
        break;
      }
    }
    return { hatched, squadFull };
  }

  async handlePlacement() {
    try {
      const r = await this.act('/api/creature/place-auto', {});
      if (r?.placed) this.log(`placed ${r.placed} creature(s)`);
    } catch (e) { /* no free creatures/slots — fine */ }
  }

  // A run is active until its status is "claimed"/"done".
  isActiveRun(run) { return run.status !== 'claimed' && run.status !== 'done'; }

  // Busy in an ACTUALLY running dungeon (party/run_id/status) — WITHOUT counting stored. Separate from
  // busyIds(), 2026-07-06 (owner: "why do we generate pets so slowly" — root cause): /api/player/load
  // returns the ACTIVE roster in `state.creatures` and vaulted creatures SEPARATELY in
  // `state.stored.creatures` (confirmed on raw data: creatures[].stored is ALWAYS false, whereas
  // stored.creatures[] carries stored:true + breed_count + stored_at). Everything that read ONLY
  // state.creatures looking for stored:true (pickBreedingGraduate, the poolSize check in pickBreedingIntake,
  // planVaultSwap's storedPool, handleBreed's pair pool, writeLive) NEVER saw the actually-vaulted creatures
  // — the whole "breeding in the vault" chain was dead code: intake admitted new ones forever (the pool was
  // never read as full), breeding never picked them as partners (they physically weren't in the passed
  // array), graduate never found the exhausted ones (same).
  // A single source of truth for places that NEED both lists at once; NOT used for dungeon dispatch
  // (busyIds/dungeonBusyIds/idleRoster) — there stored creatures deliberately must not be visible.
  // 2026-07-06, found live: on accounts where the vault was NEVER used, the real API returns
  // state.stored.creatures NOT as an array (apparently {} — an empty structure without an explicit array),
  // and `... {}` on a spread throws "is not iterable". Because of this writeLive() (the last call in tick(),
  // without its own try/catch) crashed EVERY tick after dungeons/farm/ledger had already worked successfully —
  // the farm itself lived, but the dashboard snapshot for those 6 accounts didn't update for 20-30+ min silently.
  // Array.isArray is the only reliable guard here (|| doesn't help — an object/empty array are both truthy).
  allCreatures(state) {
    const stored = Array.isArray(state.stored?.creatures) ? state.stored.creatures : [];
    return [...(state.creatures || []), ...stored];
  }

  // because a vaulted pet is NOT busy in a dungeon (it physically can't get there), but CAN breed
  // (breedAllowStored, 2026-07-05) — if we took the whole busyIds(), planBreedPair would cut it off before
  // the isBreedEligible check, making the "breed from the vault" fix dead code.
  dungeonBusyIds(state) {
    const ids = new Set();
    for (const run of state.dungeonRuns || []) {
      if (!this.isActiveRun(run)) continue;
      for (const id of run.party || []) ids.add(id);
    }
    for (const cr of state.creatures || []) {
      if (cr.status === 'Busy' || cr.status === 'In a dungeon' || cr.run_id != null || cr.runId != null) ids.add(cr.id);
    }
    return ids;
  }

  busyIds(state) {
    const ids = this.dungeonBusyIds(state);
    for (const cr of state.creatures || []) {
      // stored:true — the pet is in the vault (Vault). Without this check idleRoster/dispatchRuns would
      // count it as "free" and could send it to a dungeon (the server rejects, but it's a false signal to the
      // /power|requires|Unknown/ heuristic in dispatchRuns — a risk of wrongly reading "pet in storage" as
      // "the dungeon is too strong" and understating depthCeiling). Found on the vault audit 2026-07-05.
      if (cr.stored === true) ids.add(cr.id);
      // listed:true (2026-07-06, surplus sales list non-exhausted pets): the server rejects a listed pet in
      // a party with 409 "creature unavailable (listed)" — the same class of bug as stored above, and the
      // same risk of wrongly understating depthCeiling via the dispatchRuns heuristic.
      if (cr.listed === true) ids.add(cr.id);
    }
    return ids;
  }

  async handleDungeons(state) {
    const now = Date.now();
    let workingState = state;
    let claimedAny = false;
    // 1) claim the finished ones (ready when ready_at has passed and the run isn't claimed yet)
    for (const run of workingState.dungeonRuns || []) {
      if (!this.isActiveRun(run)) continue;
      const readyAt = run.ready_at || run.ends_at;
      const done = run.status === 'ready' || (readyAt && parseTime(readyAt) <= now);
      if (!done) continue;
      const runId = run.run_id || run.id;
      try {
        const r = await this.act('/api/dungeon/claim', { runId });
        // the reward comes in dungeonRewards (confirmed by keys= from a real response)
        const rw = r?.dungeonRewards ?? r?.reward ?? {};
        const g = rw.gold ?? rw.gold_earned ?? rw.goldGained;
        const dungeonId = run.dungeon_id || run.dungeonId || run.dungeon || r?.dungeonId || r?.dungeon_id || rw?.dungeonId || rw?.dungeon_id || null;
        const extra = g == null ? ` rewards=${JSON.stringify(rw).slice(0, 140)}` : '';
        this.log(`CLAIM run ${String(runId).slice(0, 8)} -> gold ${g ?? '?'}${extra}`);
        this.recordEvent('dungeon_claim', {
          amounts: { gold: g || 0 },
          ref: { runId, dungeonId },
          meta: { rewards: rw },
        });
        claimedAny = true;
      } catch (e) { this.log('claim err', e.status, (e.bodyText || '').slice(0, 80)); }
    }
    if (claimedAny) {
      try { workingState = await this.c.api('/api/player/load'); }
      catch (e) { this.log('post-claim reload err', e.status || '', (e.bodyText || e.message || '').slice(0, 80)); }
    }
    // Ready eggs blocked behind a FULL roster (found live 2026-07-06: Nova/Ember pinned at roster 50 / 6
    // ready eggs / 0 hatches / 0 vault+intake for 30 min, while roster-48 accounts hatched fine). Each
    // slot-freeing valve (pressure-vault + breeding intake) burns its cooldown (5-15 / 3-8 min) even on a
    // MISS — no free eligible creature in that tick's tiny post-claim window — so on a fully-dispatched
    // account the valves keep "trying" 3-8 min apart and each attempt lands when everything is busy → the
    // eggs starve indefinitely. When eggs are blocked, ZERO those two cooldowns so the valves RETRY EVERY
    // TICK until a just-claimed creature is free to hide → a slot frees → hatch (step 2c below). Self-limiting:
    // the roster un-fills the instant an egg hatches. Recycle's cooldown is left alone (it DESTROYS commons —
    // keep it on its own cadence, it's not the reliable lever on these uncommon-heavy rosters anyway).
    const eggsBlockedFullRoster = (workingState.creatures || []).length >= (Number(this.cfg.vaultRosterFull) || 49)
      && (workingState.eggs || []).some(e => e.status === 'ready'
        || (e.status === 'incubating' && e.hatch_ready_at && parseTime(e.hatch_ready_at) <= now));
    if (eggsBlockedFullRoster) { this.nextVaultAt = 0; this.nextVaultIntakeAt = 0; }
    // 2) recycle AFTER claim, BEFORE dispatch: the just-claimed commons are now free (run_id cleared), we
    //    sacrifice them into XP for the account's best Rare+ pet and free squad slots for hatching eggs. If
    //    we sacrificed — reload state so dispatch doesn't try to send an already-deleted pet.
    let freedSlot = false;
    if (this.cfg.autoRecycleCreatures && !this.inMaintenance()) {
      const recycled = await this.handleRecycle(workingState);
      if (recycled) {
        freedSlot = true;
        try { workingState = await this.c.api('/api/player/load'); }
        catch (e) { this.log('post-recycle reload err', e.status || '', (e.bodyText || e.message || '').slice(0, 80)); }
      }
    }
    // 2b) pressure valve: if the roster is FULL (blocking hatch) and recycle didn't unload it (no commons) —
    //     hide the least valuable free Rare+ in the vault. Frees a slot + the pet is preserved (not sold,
    //     not burned). Only when full → zero throughput loss. Reload state if we vaulted.
    if (this.cfg.autoVaultWhenFull && !this.inMaintenance()) {
      const vaulted = await this.handleVault(workingState);
      if (vaulted) {
        freedSlot = true;
        try { workingState = await this.c.api('/api/player/load'); }
        catch (e) { this.log('post-vault reload err', e.status || '', (e.bodyText || e.message || '').slice(0, 80)); }
      }
    }
    // 2b-ii) the dedicated in-vault breeding pipeline (2026-07-06) — the same positioning logic as
    // recycle/vault above: it needs a POST-claim snapshot to find an actually-free candidate, not "all busy
    // from last tick". graduate/swap do NOT carry freedSlot=true (no net gain of free slots: graduate returns
    // a pet to active, swap trades 1-for-1), only intake actually hides a pet in the vault exactly like handleVault.
    if (this.cfg.autoBreedingPipeline && !this.inMaintenance()) {
      // Graduate (vault→active, to sell an exhausted 8/8 breeder) and intake (active→vault, to breed a
      // fresh one) CANCEL OUT on a full roster: net-zero movement, so no active slot frees and ready eggs
      // can't hatch. Found live 2026-07-06 (owner: "incubation isn't claiming, pets aren't being added"):
      // main/Nova/Ember pinned at active 50 / vault 30 with 6 ready eggs and 0 hatches. When the roster is
      // full AND eggs are waiting, SKIP graduate so intake actually NET-frees active slots for hatching —
      // new pets take priority; the exhausted breeders wait in the vault (useless for breeding anyway) and
      // graduate resumes once hatching/selling makes room.
      // Skip graduate when eggs are blocked so intake NET-frees a hatch slot — UNLESS the breeding pool is
      // ALSO full (intake can't move anything in, poolSize>=target), in which case graduate MUST run to
      // drain the vault (→ active → sale) or roster+vault deadlock and no slot ever frees. (The current
      // stuck accounts have vault 30/60 → room → graduate stays skipped; this guards the vault-full case
      // that the more-aggressive every-tick intake above can now reach faster.)
      const vaultRarities = (this.cfg.vaultBreedingRarities || ['uncommon', 'rare', 'epic']).map(r => String(r).toLowerCase());
      const vaultPool = this.allCreatures(workingState).filter(c => c.stored === true
        && vaultRarities.includes(String(c.rarity || '').toLowerCase()) && (Number(c.breed_count) || 0) < 8).length;
      const vaultHasRoom = vaultPool < (Number(this.cfg.vaultBreedingPoolTarget) || 0);
      if (!(eggsBlockedFullRoster && vaultHasRoom)) await this.handleVaultGraduate(workingState);
      const intaken = await this.handleVaultIntake(workingState);
      if (intaken) {
        freedSlot = true;
        try { workingState = await this.c.api('/api/player/load'); }
        catch (e) { this.log('post-intake reload err', e.status || '', (e.bodyText || e.message || '').slice(0, 80)); }
      }
    }
    if (this.cfg.autoVaultSwap && !this.inMaintenance()) {
      await this.handleVaultSwap(workingState);
    }
    // 2c) we freed a roster slot (recycle/vault/intake) → hatch the ready eggs into it RIGHT AWAY, on the SAME tick.
    //     Otherwise hatch in preDungeon sees a full roster → 409 → backoff, and eggs pile up (bug: 23 of them).
    if (freedSlot && !this.inMaintenance()) {
      const hz = await this.hatchReadyEggs(workingState);
      if (hz.hatched) {
        try { workingState = await this.c.api('/api/player/load'); }
        catch (e) { this.log('post-hatch reload err', e.status || '', (e.bodyText || e.message || '').slice(0, 80)); }
      }
    }
    // 3) ε-exploration: occasionally try ONE party at ceiling+1 — otherwise optimizeDepth
    //    forever exploits below the ceiling and the ceiling doesn't grow with the hero's levelling.
    const afterProbe = await this.maybeProbeDeeper(workingState);
    // 4) start ALL the remaining parties this tick (not one) — the whole idle roster into battle.
    await this.dispatchRuns(afterProbe);
  }

  // A forced probe past the ceiling. Launches ONE strongest party at depthCeiling+1.
  // Success → the ceiling grows (dungeon difficulty climbs with the roster's power). A failure on power
  // → the ceiling is known-correct, we lose nothing. Doesn't trigger a paid refill for the probe: we probe
  // only if free stamina already suffices. Returns the (possibly reloaded) state.
  async maybeProbeDeeper(state) {
    if (!this.cfg.epsilonProbe) return state;
    const now = Date.now();
    if (now < this.nextForcedProbeAt) return state;
    if (this.depthCeiling >= 25) return state; // nowhere higher
    const target = this.depthCeiling + 1;
    const staminaCost = staminaCostForDungeon(target);
    if ((state.player?.stamina ?? Infinity) < staminaCost) return state; // don't refill for a probe
    const available = this.idleRoster(state);
    if (available.length < this.cfg.partySize) return state; // no one to probe with a full party

    this.nextForcedProbeAt = now + this.cfg.depthProbeMs;
    const party = available.slice(0, this.cfg.partySize).map(c => c.id);
    try {
      await this.act('/api/dungeon/start', { dungeonId: target, party });
      this.depthCeiling = target;
      this.depth = target;
      this.efficientDepth = null;       // power grew → recompute the optimum from scratch
      this.nextDepthCalcAt = 0;
      this.log(`PROBE ok d${target} → ceiling raised to ${target}`);
      this.recordEvent('dungeon_start', { ref: { dungeonId: target, partySize: party.length, probe: true }, meta: { party } });
      try { return await this.c.api('/api/player/load'); } catch { return state; } // the party is already busy — reload
    } catch (e) {
      const msg = (e.bodyText || '').slice(0, 100);
      if (/power|requires|Unknown/i.test(msg)) {
        this.log(`PROBE d${target} too early (power too low) — ceiling stays ${this.depthCeiling}`);
      } else {
        this.log('probe err', e.status, msg);
      }
      return state;
    }
  }

  // Free creatures, sorted by power (stage, then level).
  idleRoster(state) {
    const busy = this.busyIds(state);
    const free = (state.creatures || [])
      .filter(cr => !busy.has(cr.id))
      .sort((a, b) => ((STAGE_RANK[b.stage] ?? -1) - (STAGE_RANK[a.stage] ?? -1)) || ((b.level || 0) - (a.level || 0)));
    // When recycling is on, Common is XP material, not runners: do NOT send them into runs so they're always
    // free for recycle. Keep them out of battle WHILE the account has a Rare+ (a target to pour XP into) AND
    // at least one non-Common pet — otherwise (an account with no Rare+ or almost all Common) we give them
    // all, so the farm doesn't stall. There used to be a bug: the fallback fired every time the Rare+ were
    // busy in runs → free non-Common < party → Common went into battle again.
    if (this.cfg.autoRecycleCreatures) {
      const KEEP = new Set(['rare', 'epic', 'legendary', 'mythical']);
      const roster = state.creatures || [];
      const hasRareTarget = roster.some(c => KEEP.has(String(c.rarity || '').toLowerCase()));
      const nonCommon = free.filter(cr => String(cr.rarity || '').toLowerCase() !== 'common');
      if (hasRareTarget && nonCommon.length > 0) return nonCommon;
    }
    return free;
  }

  // Dispatch of parallel runs. Previously it started ONE run per tick → almost the whole roster sat idle,
  // and parallel runs filled one at a time once per tickMin..Max sec. Now all free creatures go into battle
  // right away in parties of partySize.
  // MONEY INVARIANT: no more than ONE paid stamina refill per tick (as before) — the multi-dispatch spends
  // only already-accumulated free stamina + at most one refill.
  async dispatchRuns(state) {
    const now = Date.now();
    let working = state;
    let available = this.idleRoster(working);
    if (available.length === 0) return 0;

    let staminaBudget = working.player?.stamina ?? Infinity;
    let refillUsed = false;
    let advanced = false; // move the depth flywheel once per tick, not on every party
    let started = 0;

    // recompute the Gold/stamina optimum by ledger (throttled), within the current ceiling
    if (this.cfg.optimizeDepth && now >= this.nextDepthCalcAt) {
      this.nextDepthCalcAt = now + this.cfg.depthRecalcMs;
      const d = bestDepth(this.loadLedgerEvents(), {
        ceiling: this.depthCeiling,
        minSamples: this.cfg.depthMinSamples,
        objective: this.cfg.depthObjective,
      });
      if (d !== this.efficientDepth) {
        this.log(`depth optimizer → ${d == null ? 'too little data (greedy mode)' : 'd' + d} (ceiling ${this.depthCeiling})`);
        this.efficientDepth = d;
      }
    }

    // target depth:
    //   a probe past the ceiling (re-evaluate power) has priority — that's how the ceiling grows;
    //   otherwise, if the optimizer is confident — aim for the best by Gold/stamina (not past the ceiling);
    //   otherwise greedy — the deepest clearable.
    let target = Math.min(this.depth, this.depthCeiling);
    if (this.depth > this.depthCeiling && now >= this.nextProbeAt) {
      target = this.depthCeiling + 1;
    } else if (this.cfg.optimizeDepth && this.efficientDepth != null) {
      target = Math.min(this.efficientDepth, this.depthCeiling);
    }
    target = Math.max(1, Math.min(25, target));

    while (available.length >= this.cfg.partySize && started < this.cfg.maxConcurrentRuns) {
      const staminaCost = staminaCostForDungeon(target);
      if (staminaBudget < staminaCost) {
        if (refillUsed) break;           // the refill for this tick is already used — stop
        refillUsed = true;
        const refilled = await this.handleStaminaRefill(working, target, staminaCost);
        if (!refilled) break;
        working = await this.c.api('/api/player/load');
        staminaBudget = working.player?.stamina ?? Infinity;
        available = this.idleRoster(working);
        continue;
      }

      const partyCreatures = available.splice(0, this.cfg.partySize);
      const party = partyCreatures.map(c => c.id);
      try {
        await this.act('/api/dungeon/start', { dungeonId: target, party });
        staminaBudget -= staminaCost;
        started++;
        this.log(`START dungeon ${target} party=${party.length}`);
        this.recordEvent('dungeon_start', {
          ref: { dungeonId: target, partySize: party.length },
          meta: { party },
        });
        if (!advanced) { // success → next tick try deeper (the flywheel), but once
          advanced = true;
          if (target < 25) this.depth = target + 1;
          if (target > this.depthCeiling) this.depthCeiling = target;
        }
      } catch (e) {
        const msg = (e.bodyText || '').slice(0, 100);
        if (/power|requires|Unknown/i.test(msg)) {
          // can't clear target → lower the ceiling and stop dispatching this tick.
          // All this tick's parties go at one depth, so if it wasn't cleared, the rest won't be either;
          // the next tick launches the whole roster at the corrected depth.
          this.depthCeiling = Math.max(1, target - 1);
          this.depth = this.depthCeiling;
          this.nextProbeAt = now + 15 * 60 * 1000;
          this.log(`depth ceiling → ${this.depthCeiling} (d${target} too strong)`);
          break;
        } else if (/stamina/i.test(msg)) {
          // the server counted stamina differently — one refill per tick, then reload state
          if (refillUsed) break;
          refillUsed = true;
          const refilled = await this.handleStaminaRefill(working, target, staminaCost);
          if (!refilled) break;
          working = await this.c.api('/api/player/load');
          staminaBudget = working.player?.stamina ?? Infinity;
          available = this.idleRoster(working);
        } else {
          this.log('dungeon start err', e.status, msg);
          break;
        }
      }
    }
    return started;
  }

  // Feed ONLY Baby/Juvenile. Feeding accumulates creature_xp, which handleEvolve(useXp:true) uses to skip
  // the maturation timer → Baby→Juv→Adult faster → party_power↑ (a stage is ×3 power) + Adult stock for
  // breeding. Do NOT feed Adult/Elder: there's no growth past Adult, it's pure Gold waste.
  // Juvenile — first (closer to Adult, the valuable stage). Cooldown 11m (see FEED_COOLDOWN_MS).
  async handleFeeding(state) {
    const now = Date.now();
    const p = state.player || {};
    let fed = 0;
    // allCreatures (2026-07-06, owner: "feed the non-active ones in the vault too, right?") —
    // vault-breeding intake requires Adult+ (see allCreatures()), so in practice there's no overlap with
    // Baby/Juvenile right now; but the general autoVaultWhenFull (full roster) vaults ANY Rare+ regardless of
    // stage, so a Baby/Juvenile Rare+ could theoretically sit unfed in the vault. The same root cause as
    // breeding — we fix it with the same pattern rather than leaving a hole.
    const feedable = this.allCreatures(state)
      .filter(c => c.stage === 'Baby' || c.stage === 'Juvenile')
      .sort((a, b) => (STAGE_RANK[b.stage] ?? -1) - (STAGE_RANK[a.stage] ?? -1));
    // The per-tick cap is configurable (2026-07-06): after an egg burst accounts have dozens of Babies
    // (Ember: 34), and a hardcoded 3 gave ~2.2 feeds/min when ~3.3 was needed — youngsters matured slower
    // than possible, the breeding conveyor (needs Adult) starved. Default 3 = old behavior.
    const feedCap = Math.max(1, Number(this.cfg.feedMaxPerTick) || 3);
    for (const cr of feedable) {
      if (fed >= feedCap) break; // don't spam (human)
      const last = parseTime(cr.last_feed_time);
      if (now - last < FEED_COOLDOWN_MS) continue;
      if ((p.gold ?? 0) <= this.cfg.minGoldReserve) break;
      try {
        await this.act('/api/creature/feed', { creatureId: cr.id });
        this.log(`feed ${cr.species || cr.id.slice(0, 6)} ${cr.stage}`);
        // Previously feeding was NEVER written to the ledger — a real, constant Gold spend was invisible to
        // our own analytics ("gold is going somewhere", owner 2026-07-05). The exact feed price is NOT
        // documented (NOTES.md only knows the 10-min cooldown) — we don't invent a number
        // (costTracked:false), but we make the activity itself visible (the dashboard flywheel strip, the
        // ledger feed), rather than fully silent.
        this.recordEvent('creature_feed', { ref: { creatureId: cr.id }, meta: { species: cr.species, stage: cr.stage, costTracked: false } });
        fed++;
      }
      catch (e) {
        // 2026-07-06 (owner: "some 409 error, are the pets even feeding?"): a BUG — the only place in the
        // whole file where 409 wasn't in the standard "expected, not critical" set [400,402,409]
        // (see relic/breed/forge/vault/evolve etc.). A 409 here is the same server cooldown lag already
        // described above (FEED_COOLDOWN_MS=11m instead of the documented 10m) — a completely normal
        // situation, not a failure. Previously it broke the WHOLE feeding cycle this tick (break) — one pet
        // with a not-fully-elapsed cooldown blocked feeding the rest. Live data confirmed: main/spare fed
        // ~1.1-1.4 times/2h per pet vs ~5-6 times/2h for the others.
        if ([400, 402, 409, 429].includes(e.status)) continue; // skip this pet, try the next
        this.log('feed err', e.status, (e.bodyText || '').slice(0, 60)); // unexpected — possibly a systemic problem, don't keep hammering this tick
        break;
      }
    }
  }

  // Recycle Common pets into XP for the account's best pet (sacrifice → XP).
  // Called INSIDE handleDungeons — between claim and dispatch: the just-claimed commons are already free
  // (run_id cleared), and dispatchRuns hasn't sent them into a new run yet. This is the only window where
  // commons are actually free for a sacrifice. ⚠️ IRREVERSIBLE. Returns true if it sacrificed.
  async handleRecycle(state) {
    if (!this.cfg.autoRecycleCreatures) return false;
    const now = Date.now();
    if (now < this.nextRecycleAt) return false;
    let busyIds = this.busyIds(state);
    let creatures = state.creatures || [];
    const target = pickRecycleTarget(creatures, { busyIds });
    if (!target) { this.recycleSkipLog('no Rare+ target'); return false; }
    // Unplace stuck fodder from plots (place-auto parked commons on the island → they fell out of sacrifice
    // and NEVER went into XP). There's an XP target → free them and reload state.
    if (this.cfg.autoUnplaceFodder !== false) {
      const cap = Math.max(1, Number(this.cfg.recycleMaxPerTick) || 5);
      const placedFodder = pickPlacedFodder(creatures, this.cfg).slice(0, cap);
      if (placedFodder.length) {
        let unplaced = 0;
        for (const c of placedFodder) {
          try { await this.act('/api/creature/place', { creatureId: c.id, unplace: true }); unplaced++; }
          catch (e) {
            // Previously 400/404/409 here were FULLY silent — during a live investigation ("eggs aren't
            // moving") we found eggs on main overdue by 10+ hours at a roster exactly at cap(50) and recycle
            // steadily reporting the same 1 "placed" common — i.e. unplace apparently kept failing, but there
            // was nothing to diagnose it with. Now it's visible (throttled).
            if (![400, 404, 409].includes(e.status)) this.log('unplace err', e.status, (e.bodyText || '').slice(0, 60));
            else this.recycleSkipLog(`unplace ${e.status} for ${c.id}: ${(e.bodyText || '').slice(0, 100)}`);
          }
        }
        if (unplaced) {
          this.log(`UNPLACE ${unplaced} fodder → into the XP funnel`);
          this.recordEvent('creature_unplace', { ref: { count: unplaced } }); // for the dashboard's flywheel activity strip
          try { state = await this.c.api('/api/player/load'); creatures = state.creatures || []; busyIds = this.busyIds(state); }
          catch (e) { this.log('post-unplace reload err', e.status || '', (e.bodyText || e.message || '').slice(0, 60)); }
        }
      }
    }
    const fodder = pickRecycleFodder(creatures, { ...this.cfg, busyIds })
      .filter(c => c.id !== target.id);
    if (!fodder.length) {
      // Diagnose the real blockers (bound is NO LONGER a blocker — we sacrifice it). We count by the same
      // rarities as fodder, and by the same traits that exclude from pickRecycleFodder.
      const rar = new Set((this.cfg.recycleFodderRarities || ['common', 'uncommon']).map(r => String(r).toLowerCase()));
      const pool = creatures.filter(c => rar.has(String(c.rarity || '').toLowerCase()));
      const placed = pool.filter(c => c.plot_x != null || c.plotX != null || c.plot_y != null || c.plotY != null || c.placed).length;
      const inRun = pool.filter(c => c.run_id != null || c.runId != null || c.stored === true).length;
      const special = pool.filter(c => { const v = String(c.variant || '').toLowerCase(); return v && v !== 'normal'; }).length;
      this.recycleSkipLog(`no free fodder (${pool.length} ${[...rar].join('/')}: ${inRun} in runs/vault, ${placed} placed, ${special} special variant)`);
      return false;
    }
    const cap = Math.max(1, Number(this.cfg.recycleMaxPerTick) || 5);
    const batch = fodder.slice(0, cap).map(c => c.id);
    this.nextRecycleAt = now + this.rand(this.cfg.recycleCooldownMinMs, this.cfg.recycleCooldownMaxMs);
    if (this.cfg.recycleDryRun) {
      this.log(`RECYCLE(dry) ${batch.length} fodder → XP into ${target.species || String(target.id).slice(0, 6)} (${target.rarity || '?'} target kept)`);
      return false;
    }
    try {
      await this.recycleFodder(target.id, batch);
      this.recordEvent('creature_sacrifice', {
        ref: { targetId: target.id, count: batch.length },
        meta: { fodderIds: batch, targetSpecies: target.species, targetRarity: target.rarity },
      });
      // wording is explicit (owner 2026-07-06 misread "RECYCLE 1 → X Rare" as "recycled a Rare"): the
      // target is the Rare+ pet that GAINS XP and is KEPT; only the fodder (common/exhausted-uncommon) is consumed.
      this.log(`RECYCLE ${batch.length} fodder → XP into ${target.species || String(target.id).slice(0, 6)} ${target.rarity || ''} (target kept, ${batch.length} slots freed)`);
      return true;
    } catch (e) {
      this.log('recycle err', e.status || '', (e.bodyText || e.message || '').slice(0, 80));
      return false;
    }
  }

  // Vault valve: "rares into the vault" ONLY when the roster is full. Hides the least valuable free Rare+ in
  // storage (/api/storage/move store:true) — frees a roster slot for hatch, the pet is preserved (not sold,
  // not burned). Reversible (store:false). We don't touch the top-N Rare+ (dungeon runners) or the recycle
  // target → zero throughput loss (it fires only once we've hit the cap). true if it vaulted.
  async handleVault(state) {
    if (!this.cfg.autoVaultWhenFull) return false;
    const creatures = state.creatures || [];
    if (creatures.length < (Number(this.cfg.vaultRosterFull) || 49)) return false; // not full — don't touch
    const now = Date.now();
    if (now < this.nextVaultAt) return false;
    const busyIds = this.busyIds(state);
    const protect = pickRecycleTarget(creatures, { busyIds }); // the strongest Rare+ (XP target) — don't vault
    const cand = pickVaultCandidate(creatures, this.cfg, { busyIds, protectId: protect?.id });
    if (!cand) { this.recycleSkipLog(`roster full (${creatures.length}), but no free Rare+ to vault`); return false; }
    this.nextVaultAt = now + this.rand(this.cfg.recycleCooldownMinMs, this.cfg.recycleCooldownMaxMs);
    try {
      await this.act('/api/storage/move', { itemKind: 'creature', itemId: cand.id, store: true });
      this.log(`VAULT ${cand.species || cand.creature_id || String(cand.id).slice(0, 6)} ${cand.rarity || ''} (roster full ${creatures.length} → slot freed, pet in the vault)`);
      this.recordEvent('creature_vault', { ref: { creatureId: cand.id }, meta: { rarity: cand.rarity, rosterSize: creatures.length } });
      return true;
    } catch (e) {
      if (![400, 404, 409].includes(e.status)) this.log('vault err', e.status || '', (e.bodyText || e.message || '').slice(0, 60));
      return false;
    }
  }

  // Fleet↔vault swap: continuous roster polishing ON TOP of handleVault (that's a one-shot valve under
  // pressure, forgets forever; no one returns from the vault on its own). If the vault holds a Rare+ more
  // valuable than the weakest active runner — swap them. NOT gated by roster fullness (unlike handleVault) —
  // this is a separate, rarer, opt-in optimizer. The API-call order is critical: first hide the weak one
  // (frees a slot), THEN withdraw the strong one — so we never ask for a slot over the cap. Free/reversible,
  // the server rejects invalid ones 400/404/409.
  async handleVaultSwap(state) {
    if (!this.cfg.autoVaultSwap) return false;
    const now = Date.now();
    if (now < this.nextVaultSwapAt) return false;
    this.nextVaultSwapAt = now + this.rand(this.cfg.vaultSwapCooldownMinMs, this.cfg.vaultSwapCooldownMaxMs);
    // allCreatures — storedPool in planVaultSwap looks for stored:true, which live only in
    // state.stored.creatures (see allCreatures()); otherwise storedPool was always empty and the swap never
    // found anything to admit back into the lineup.
    const creatures = this.allCreatures(state);
    const busyIds = this.busyIds(state);
    const protect = pickRecycleTarget(creatures, { busyIds }); // the strongest Rare+ (XP target) — don't touch
    const plan = planVaultSwap(creatures, this.cfg, { busyIds, protectId: protect?.id });
    if (!plan) return false;
    try {
      await this.act('/api/storage/move', { itemKind: 'creature', itemId: plan.evict.id, store: true });
      this.recordEvent('creature_vault', { ref: { creatureId: plan.evict.id }, meta: { rarity: plan.evict.rarity, swap: true } });
    } catch (e) {
      if (![400, 404, 409].includes(e.status)) this.log('vault swap evict err', e.status || '', (e.bodyText || e.message || '').slice(0, 60));
      return false;
    }
    try {
      await this.act('/api/storage/move', { itemKind: 'creature', itemId: plan.admit.id, store: false });
      this.log(`SWAP ${plan.evict.species || String(plan.evict.id).slice(0, 6)} ${plan.evict.rarity || ''} → vault, ${plan.admit.species || String(plan.admit.id).slice(0, 6)} ${plan.admit.rarity || ''} → into the lineup`);
      this.recordEvent('creature_unvault', { ref: { creatureId: plan.admit.id }, meta: { rarity: plan.admit.rarity, swap: true } });
      return true;
    } catch (e) {
      // the evict already went through — the slot wasn't freed for nothing, we just didn't take the upgrade this time (the server rejected it).
      if (![400, 404, 409].includes(e.status)) this.log('vault swap admit err', e.status || '', (e.bodyText || e.message || '').slice(0, 60));
      return false;
    }
  }

  // Intake into the vault for breeding: keep a pool of vaultBreedingPoolTarget Uncommon/Rare INSIDE the
  // vault specifically for breeding (free there — see handleBreed/planBreedPair). We top up only if the
  // current pool (vaulted ones of the right rarity, not yet exhausted) is below the target — otherwise the
  // vault would grow forever, eating the whole active roster. One move per pass.
  async handleVaultIntake(state) {
    if (!this.cfg.autoBreedingPipeline) return false;
    const now = Date.now();
    if (now < this.nextVaultIntakeAt) return false;
    this.nextVaultIntakeAt = now + this.rand(this.cfg.vaultIntakeCooldownMinMs, this.cfg.vaultIntakeCooldownMaxMs);
    // allCreatures — WITHOUT this poolSize counted ONLY over state.creatures, where stored:true never occurs
    // (see allCreatures()); the pool read as forever empty → intake never stopped at the target of 10, but
    // endlessly scooped the whole Adult+ active roster into the vault without stopping.
    const creatures = this.allCreatures(state);
    const rarities = new Set((this.cfg.vaultBreedingRarities || ['uncommon', 'rare']).map(r => String(r).toLowerCase()));
    let poolSize = creatures.filter(c => c.stored === true && rarities.has(String(c.rarity || '').toLowerCase()) && (Number(c.breed_count) || 0) < 8).length;
    if (poolSize >= (Number(this.cfg.vaultBreedingPoolTarget) || 0)) return false;
    // Batch intake 2026-07-06: one creature per 10-20 min would unload a 50/50 roster over ~10 hours, all
    // that time hatch stalls (squad-full) and ready eggs hold the incubator. Up to vaultIntakeMaxPerTick per
    // call; admitted ones are added to busyIds so pickBreedingIntake doesn't pick the same one twice.
    const busyIds = new Set(this.busyIds(state));
    const maxPerTick = Math.max(1, Number(this.cfg.vaultIntakeMaxPerTick) || 1);
    let intaken = 0;
    for (let i = 0; i < maxPerTick && poolSize < (Number(this.cfg.vaultBreedingPoolTarget) || 0); i++) {
      const cand = pickBreedingIntake(creatures, this.cfg, { busyIds });
      if (!cand) break;
      busyIds.add(cand.id);
      try {
        await this.act('/api/storage/move', { itemKind: 'creature', itemId: cand.id, store: true });
        poolSize++; intaken++;
        this.log(`INTAKE ${cand.species || String(cand.id).slice(0, 6)} ${cand.rarity || ''} → vault for breeding (pool ${poolSize}/${this.cfg.vaultBreedingPoolTarget})`);
        this.recordEvent('creature_vault', { ref: { creatureId: cand.id }, meta: { rarity: cand.rarity, reason: 'breeding-intake' } });
      } catch (e) {
        if (![400, 404, 409].includes(e.status)) this.log('vault intake err', e.status || '', (e.bodyText || e.message || '').slice(0, 60));
        break; // a server rejection (e.g. a vault limit) — a common cause, don't hammer the rest of the batch
      }
    }
    return intaken > 0;
  }

  // Release from the vault on exhaustion: once a "for-breeding" vaulted pet reaches breed_count>=8, we
  // withdraw it — otherwise pickJunkCreatures never sees it (stored counts as busy) and it would just sit
  // idle forever in the vault, having bred out. After release, ordinary selling (the junkMinBreedCount
  // gate) picks it up on the next ticks as an ordinary active candidate.
  async handleVaultGraduate(state) {
    if (!this.cfg.autoBreedingPipeline) return false;
    const now = Date.now();
    if (now < this.nextVaultGraduateAt) return false;
    this.nextVaultGraduateAt = now + this.rand(this.cfg.vaultGraduateCooldownMinMs, this.cfg.vaultGraduateCooldownMaxMs);
    // allCreatures — pickBreedingGraduate looks for stored:true+breed_count>=8; such creatures live only in
    // state.stored.creatures (see allCreatures()), so before this fix graduate could NEVER fire at any
    // breed_count — not a bug of this function specifically, the same general root cause.
    const cand = pickBreedingGraduate(this.allCreatures(state), this.cfg);
    if (!cand) return false;
    try {
      await this.act('/api/storage/move', { itemKind: 'creature', itemId: cand.id, store: false });
      this.log(`GRADUATE ${cand.species || String(cand.id).slice(0, 6)} ${cand.rarity || ''} bred out 8/8 → from the vault to sale`);
      this.recordEvent('creature_unvault', { ref: { creatureId: cand.id }, meta: { rarity: cand.rarity, reason: 'bred-exhausted' } });
      return true;
    } catch (e) {
      if (![400, 404, 409].includes(e.status)) this.log('vault graduate err', e.status || '', (e.bodyText || e.message || '').slice(0, 60));
      return false;
    }
  }

  // Throttled log of the recycle-skip reason (about once per 5 min), to diagnose without spam.
  recycleSkipLog(reason) {
    const now = Date.now();
    if (now < (this.nextRecycleSkipLogAt || 0)) return;
    this.nextRecycleSkipLogAt = now + 5 * 60 * 1000;
    this.log(`recycle skip: ${reason}`);
  }

  // A narrow explicit sacrifice call — not through the generic act(). Guarantees the target isn't in the fodder.
  async recycleFodder(targetId, fodderIds) {
    if (!targetId) throw new Error('recycle: no target');
    if (!Array.isArray(fodderIds) || !fodderIds.length) throw new Error('recycle: no fodder');
    if (fodderIds.includes(targetId)) throw new Error('recycle: target present in fodder');
    return this.c.api('/api/creature/sacrifice', { targetId, fodderIds });
  }

  // Unlist active creature listings (when creature selling is off) — once.
  async unlistCreatureListings() {
    let active = [];
    try {
      active = (await getMyListings(this.c, { itemKind: 'creature' }))
        .filter(r => isActiveListing(r) && String(r.itemKind || '').toLowerCase() === 'creature');
    } catch (e) { this.log('unlist read err', e.status || '', (e.message || '').slice(0, 60)); return; }
    for (const l of active) {
      try {
        await cancelListing(this.c, l.id);
        this.recordEvent('market_cancel', { ref: { listingId: l.id, itemKind: 'creature', itemId: l.itemId }, meta: { reason: 'stop-selling-creatures' } });
        this.log(`UNLIST creature ${String(l.id).slice(0, 8)}`);
      } catch (e) { this.log('unlist err', e.status || '', (e.message || '').slice(0, 60)); }
    }
  }

  async handleClaims(state) {
    // idle gold — cheap, always try
    try { const r = await this.act('/api/idle/claim'); if (r?.gold) this.log(`idle +${r.gold} gold`); } catch { /* nothing to claim */ }
    // daily — once a day
    if (!isSameDay(parseTime(state.player?.last_daily_at))) {
      try { await this.act('/api/daily/claim', {}); this.log('daily claimed'); } catch { /* already claimed */ }
    }
  }

  async runForever() {
    this.log('bot started');
    for (;;) {
      let liveState;
      try { liveState = await this.tick(); }
      catch (e) { this.log('tick error:', e.status || '', (e.bodyText || e.message || '').slice(0, 120)); }
      await sleep(this.nextWaitMs(liveState));
    }
  }
}
