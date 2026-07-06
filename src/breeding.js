// Tier-climb breeding planner (pure, testable). Mechanic (researched 2026-07-04, RE-VERIFIED against
// the official wiki 2026-07-06 after a friend's claim "rares with rares, epics with epics"):
//   result tier = min(parent tiers)+1, cap T4; both parents Adult/Elder; happiness ≥50;
//   element-compatible; 25-min cooldown on both after each attempt; lifetime cap 8 attempts/creature
//   (success AND fail both count); bound parent → bound offspring; costs Gold only (T0→T1 3k,
//   T1→T2 10k, T2→T3 30k, T3→T4 80k).
//
// ⚠️ The wiki is explicit that TIER (a hidden lineage counter) and RARITY (a display/power badge) are
// INDEPENDENT — it gives a worked example of two RARE-badge creatures at different tiers that do NOT
// resolve as a matched pair "despite the matching RARE badge." So neither same-species NOR same-rarity
// is the server's real rule — tier+element is. We can't read tier or element from the API at all (no
// field on the creature object, no species-catalog endpoint), so BOTH same-species and same-rarity are
// only ever proxies for the real mechanic, not the mechanic itself.
//
// Why RARITY is the grouping key (2026-07-06, friend's instruction, adopted over the previous
// same-species-only approach): rarity is something we can actually read AND it's a strict WIDENING —
// every same-species pair is also same-rarity (same species never spans two rarities in this game's
// dex), so nothing that used to pair still can't; it just ALSO allows cross-species same-rarity pairs
// the old approach skipped entirely for lack of a same-species duplicate. Within a rarity group we
// still PREFER a same-species sub-pair when one exists (zero element-mismatch risk, proven safe all
// session).
//
// CROSS-SPECIES FALLBACK IS OPT-IN, OFF BY DEFAULT (2026-07-06, friend's fuller follow-up: "one
// species, one rarity, one tier, FOR BOTH parents; if they differ it's −1 level" — a mismatch is
// tolerated by the server but confirmed to produce a WORSE result, not just a "maybe rejected" one).
// That's stronger than "cross-species is a free-to-try fallback" — it's "cross-species is a known-worse
// outcome," so by default we simply DON'T breed at all rather than accept a worse pair;
// `breedAllowCrossSpecies:true` re-enables the fallback for an owner who'd rather trade result quality
// for higher breeding throughput/volume.

const STAGE_RANK = { baby: 0, juvenile: 1, adult: 2, elder: 3 };
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythical: 5 };
const lower = (s) => String(s ?? '').toLowerCase();

// Lux element (2026-07-06, owner: "make sure the pets are Lux"; friend: "lux with lux"). 14 species from
// wiki/creatures; there's no element field in the API — species is the only marker. The canonical set
// lives here (breeding is the main consumer), marketplace.js imports it. CRITICAL: the lux ladder starts
// from a COMMON pair (glimra/lumen → Gleamguard T1) — no purchasable lux-Uncommon eggs exist (wiki:
// "no Void/Lux Uncommon or Rare egg-species"), so lux commons are exempt from breedMinRarity.
export const LUX_SPECIES = new Set([
  'glimra', 'lumen',                       // Common — breeding stock for T1
  'gleamguard',                            // Uncommon — breeds T1
  'lucentia', 'luminara', 'prismark',      // Rare
  'eclipsyn', 'solarknight',               // Epic
  'aurelia', 'divinium',                   // Legendary
  'wishling', 'cosmium', 'chronovex', 'solivanna', // Mythical
]);
export const isLuxCreature = (c) => LUX_SPECIES.has(lower(c?.species || c?.creature_id));
const isBound = (c) => Boolean(c?.bound || c?.is_bound || c?.isBound || c?.soulbound || c?.soul_bound || c?.tradeable === false);

// Approx Gold cost from the pair's min rarity used as a tier proxy (ladder: T1=Unc, T2=Rare, T3=Epic;
// Common⇒T0→T1). ⚠️ shop creatures are T0 at ANY rarity, so this is a best-effort estimate for
// ledger/logs only — offspring correctness never depends on it (server decides via same-species).
const BREED_COST_BY_MINRARITY = { common: 3000, uncommon: 10000, rare: 30000, epic: 80000 };

export function speciesKey(c) {
  return lower(c?.species || c?.creature_id || 'unknown');
}

export function breedCooldownElapsed(c, now, cooldownMs) {
  const last = c?.last_breed_time ? Date.parse(c.last_breed_time) : 0;
  return !last || Number.isNaN(last) || (now - last) >= cooldownMs;
}

// The single source of truth for eligibility gates — returns the NAME of the first failed gate
// (for the diagnostic skip-log) or null if the creature qualifies. isBreedEligible is a thin
// wrapper (reason===null). Previously happiness/cooldown were invisible to diagnostics: if no plan
// was found, handleBreed couldn't say WHY — 2026-07-05, during a live investigation ("breeding silent
// for 4 hours" it was impossible to tell "no valid pair" from "a pair exists but a hidden gate
// (happiness/cooldown) or a silently-swallowed 400 from the API blocks it." The dashboard's
// creaturesList doesn't write these fields — the only way to see the reason is to log it from the bot
// itself against live data.
export function breedIneligibleReason(c, cfg = {}, now = Date.now()) {
  if (!c) return 'missing';
  if ((STAGE_RANK[lower(c.stage)] ?? -1) < STAGE_RANK.adult) return 'stage<Adult';
  if ((Number(c.happiness) || 0) < (cfg.breedMinHappiness ?? 50)) return `happiness<${cfg.breedMinHappiness ?? 50}`;
  if ((Number(c.breed_count) || 0) >= (cfg.breedMaxCount ?? 8)) return 'breed_count>=cap';
  if (!breedCooldownElapsed(c, now, cfg.breedCooldownMs ?? 25 * 60 * 1000)) return 'cooldown';
  const rr = RARITY_RANK[lower(c.rarity)] ?? 0;
  const minrr = RARITY_RANK[lower(cfg.breedMinRarity ?? 'common')] ?? 0;
  const maxrr = RARITY_RANK[lower(cfg.breedMaxRarity ?? 'epic')] ?? 3;
  // lux commons are exempt from the lower bound (see LUX_SPECIES): breeding them is the only path to
  // lux-Uncommon. Disableable via breedLuxAnyRarity:false.
  const luxBypass = cfg.breedLuxAnyRarity !== false && isLuxCreature(c);
  if (rr < minrr && !luxBypass) return 'rarity<min'; // below the window: Common — XP fodder, don't breed (friend's strategy: start at Uncommon)
  if (rr > maxrr) return 'rarity>max';        // above the window: Legendary/Mythical (≈T4 end / capped → server rejects)
  if (c.is_favorite || c.favorite) return 'favorite';
  if (c.listed) return 'listed';
  // A vaulted (safe) pet CAN breed by default (2026-07-05, owner: "you can breed from the vault, right"
  // — otherwise it just sits idle, zero use at all). Breeding doesn't change storage status (the server
  // rejects with 400 if the assumption is wrong — money-safe, we lose nothing). Disabled explicitly via
  // breedAllowStored:false if it turns out to break something server-side.
  if (c.stored && cfg.breedAllowStored === false) return 'stored';
  return null;
}

// Can this single creature be a breed parent right now?
export function isBreedEligible(c, cfg = {}, now = Date.now()) {
  return breedIneligibleReason(c, cfg, now) === null;
}

// Diagnostic-only: why did planBreedPair find no pair this tick? Groups ALL creatures (not just the
// eligible ones) by RARITY (see the module comment above — rarity, not species, is now the grouping
// key), takes the largest group of 2+, and prints each member's unavailability reason (or 'busy' if
// excluded by busyIds). Never used for eligibility decisions — only for the throttled skip-log.
// null if no rarity has 2+ individuals at all.
export function describeBreedSkip(creatures = [], cfg = {}, now = Date.now()) {
  const busyIds = cfg.busyIds instanceof Set ? cfg.busyIds : new Set(cfg.busyIds || []);
  const byRarity = new Map();
  for (const c of creatures || []) {
    if (!c) continue;
    const key = lower(c.rarity);
    if (!byRarity.has(key)) byRarity.set(key, []);
    byRarity.get(key).push(c);
  }
  let largest = null;
  for (const entry of byRarity) {
    if (entry[1].length >= 2 && (!largest || entry[1].length > largest[1].length)) largest = entry;
  }
  if (!largest) return null;
  const [rarity, group] = largest;
  const reasons = group.map((c) => (busyIds.has(c.id) ? 'busy' : (breedIneligibleReason(c, cfg, now) ?? 'ELIGIBLE?!'))).join(',');
  return `${rarity}×${group.length}: [${reasons}]`;
}

// Pick the best same-rarity pair to breed, or null. busyIds = creatures currently in a run (never
// yank a running pet — it wastes its cooldown/cap and the server 409s). Groups by RARITY (not species —
// see module comment); within a rarity group, prefers the largest same-species sub-pair (zero
// element-mismatch risk) and — ONLY if breedAllowCrossSpecies:true (default false, see module comment) —
// falls back to a cross-species pair at that rarity when no species has a duplicate there. Among the
// chosen pool, prefer STORED (vaulted) parents first — ZERO opportunity
// cost, they already don't run dungeons at all (2026-07-05, owner: "breed from the vault"); then the two
// LOWEST (stage,level) among the rest — least useful as runners, least disruptive to keep off-duty for
// 25m. Across rarities, go BOTTOM-UP (uncommon→rare→epic, friend's instruction): breed the LOWEST
// rarity group first, building volume from the bottom. Tie-break: unbound (sellable) pair, then more
// duplicates (more pipeline volume), then name.
export function planBreedPair(creatures = [], cfg = {}, now = Date.now()) {
  const busyIds = cfg.busyIds instanceof Set ? cfg.busyIds : new Set(cfg.busyIds || []);
  const byRarity = new Map();
  for (const c of creatures) {
    if (!c || busyIds.has(c.id)) continue;
    if (!isBreedEligible(c, cfg, now)) continue;
    const key = lower(c.rarity);
    if (!byRarity.has(key)) byRarity.set(key, []);
    byRarity.get(key).push(c);
  }
  const bySL = (a, b) =>
    (Number(!!b.stored) - Number(!!a.stored)) ||                             // vaulted first (zero opportunity cost)
    ((STAGE_RANK[lower(a.stage)] ?? 0) - (STAGE_RANK[lower(b.stage)] ?? 0)) ||
    ((Number(a.level) || 0) - (Number(b.level) || 0));
  // Prefer a pair of UNBOUND parents → tradeable offspring (a bound parent → bound offspring, and bound
  // can't be sold — only XP/runners). If there aren't two unbound, take any two lowest (a bound climb
  // still raises the tier, the offspring goes into the XP funnel). Parents are the lowest (stage,level).
  const bestPairFrom = (pool) => {
    const unbound = pool.filter((c) => !isBound(c)).sort(bySL);
    const pair = unbound.length >= 2 ? [unbound[0], unbound[1]] : pool.slice().sort(bySL).slice(0, 2);
    return { pair, pairUnbound: !isBound(pair[0]) && !isBound(pair[1]) };
  };
  let best = null;
  for (const [rarity, group] of byRarity) {
    if (group.length < 2) continue;
    // Within a rarity: evaluate EVERY same-species subgroup (0% element-rejection risk — proven all
    // session) as a separate candidate — so an equally-sized unbound subgroup doesn't lose to the first
    // bound subgroup of the same size. The whole rarity group (cross-species) is a fallback candidate
    // only if NO species at this rarity has a duplicate, AND breedAllowCrossSpecies:true.
    const bySpecies = new Map();
    for (const c of group) {
      const sk = speciesKey(c);
      if (!bySpecies.has(sk)) bySpecies.set(sk, []);
      bySpecies.get(sk).push(c);
    }
    const pools = [...bySpecies.values()].filter((g) => g.length >= 2);
    // no species has a duplicate → cross-species fallback ONLY if explicitly allowed (see module comment)
    if (!pools.length) {
      if (cfg.breedAllowCrossSpecies !== true) continue;
      pools.push(group);
    }

    let poolBest = null;
    for (const pool of pools) {
      const { pair, pairUnbound } = bestPairFrom(pool);
      const c = { pair, pairUnbound, size: pool.length };
      const better = !poolBest
        || (c.pairUnbound && !poolBest.pairUnbound)
        || (c.pairUnbound === poolBest.pairUnbound && c.size > poolBest.size);
      if (better) poolBest = c;
    }
    const { pair, pairUnbound, size } = poolBest;
    const minRR = RARITY_RANK[rarity] ?? 0; // both parents are the SAME rarity by construction of the group
    const sA = speciesKey(pair[0]), sB = speciesKey(pair[1]);
    const speciesLabel = sA === sB ? sA : `${sA}/${sB}`; // cross-species pair — both names into the log/ledger
    const cand = { speciesLabel, pair, minRR, pairUnbound, size };
    const better = !best
      || cand.minRR < best.minRR                                            // lower rarity — first (bottom-up, friend)
      || (cand.minRR === best.minRR && cand.pairUnbound && !best.pairUnbound) // tie: unbound pair = sellable offspring
      || (cand.minRR === best.minRR && cand.pairUnbound === best.pairUnbound && cand.size > best.size) // tie: more duplicates
      || (cand.minRR === best.minRR && cand.pairUnbound === best.pairUnbound && cand.size === best.size && cand.speciesLabel < best.speciesLabel); // tie: name
    if (better) best = cand;
  }
  if (!best) return null;
  const minRarity = Object.keys(RARITY_RANK).find((k) => RARITY_RANK[k] === best.minRR) || 'common';
  return {
    species: best.speciesLabel,
    pair: best.pair,
    minRarity,
    pairUnbound: best.pairUnbound,
    estCostGold: BREED_COST_BY_MINRARITY[minRarity] ?? null,
  };
}
