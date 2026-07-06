// Dungeon-depth optimizer by "Gold per stamina".
// Stamina is a scarce FREE resource (regen dripped by the AFK zone ×2), so the goal
// "maximum Gold per day" under free grinding is equivalent to "maximum Gold per unit of
// stamina", NOT "deeper at any cost": depth 21+ costs 18 stamina vs 6 at d1-5, and if
// the reward doesn't grow faster than the cost, a deep run mines less Gold/hour.
//
// Data source — the ledger (dungeon_claim events with a known depth and positive Gold).
// Reward data quality: claim writes ref.dungeonId from the run object; if the server didn't
// return it (null) the event is left out of the calculation so it doesn't skew the average.
import { staminaCostForDungeon } from './stamina.js';

// Average Gold-per-run and Gold-per-stamina for each observed depth.
// Returns Map<depth, { samples, goldAvg, goldPerStamina }>.
export function goldPerStaminaByDepth(events = [], { staminaCostFn = staminaCostForDungeon } = {}) {
  const acc = new Map(); // depth -> { n, sumGold }
  for (const e of events) {
    if (e?.type !== 'dungeon_claim') continue;
    const depth = Number(e.ref?.dungeonId);
    if (!Number.isInteger(depth) || depth < 1 || depth > 25) continue;
    const gold = Number(e.amounts?.gold);
    if (!Number.isFinite(gold) || gold <= 0) continue; // 0/unknown — don't spoil the average
    const cur = acc.get(depth) || { n: 0, sumGold: 0 };
    cur.n += 1;
    cur.sumGold += gold;
    acc.set(depth, cur);
  }
  const byDepth = new Map();
  for (const [depth, { n, sumGold }] of acc) {
    const goldAvg = sumGold / n;
    const cost = staminaCostFn(depth) || 1;
    byDepth.set(depth, { samples: n, goldAvg, goldPerStamina: goldAvg / cost });
  }
  return byDepth;
}

// Best depth within [1, ceiling] among those with >= minSamples observations.
// objective:
//   'gold-per-stamina' — max Gold per unit of stamina (stamina is scarce: free grind, no refills);
//   'gold-per-run'     — max Gold per RUN (stamina not scarce: unlimited tokens / aggressive refills;
//                        goal is max reward and levelling per run, i.e. the deepest PROFITABLE depth).
// null — not enough data; the caller falls back to greedy "deepest clearable".
export function bestDepth(events = [], {
  ceiling = 25,
  minSamples = 3,
  objective = 'gold-per-stamina',
  staminaCostFn = staminaCostForDungeon,
} = {}) {
  const byDepth = goldPerStaminaByDepth(events, { staminaCostFn });
  const score = objective === 'gold-per-run'
    ? (stat) => stat.goldAvg
    : (stat) => stat.goldPerStamina;
  let best = null;
  for (const [depth, stat] of byDepth) {
    if (depth > ceiling) continue;
    if (stat.samples < minSamples) continue;
    const s = score(stat);
    if (!best || s > best.score) best = { depth, score: s };
  }
  return best ? best.depth : null;
}

// Backwards compatibility: thin wrapper around bestDepth with a fixed Gold/stamina objective.
export function bestGoldPerStaminaDepth(events = [], opts = {}) {
  return bestDepth(events, { ...opts, objective: 'gold-per-stamina' });
}
