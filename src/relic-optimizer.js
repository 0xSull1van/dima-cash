// Score relics by stats and plan "best-to-strongest" equipping.
// party_power (the server's dungeon-depth gate) grows from equipped relics, but the bot wasn't using
// them — in the live state Rare relics sat with equipped_on:null. This module decides what goes on whom.
//
// The server's slot model isn't confirmed in the bundle (see NOTES.md), so the assumptions are:
//   A) an equip slot is identified by relic.slot (passed as `slot` in the equip body);
//   B) at most one relic per unique slot per creature;
//   C) only class="combat" relics go on creatures.
// A wrong assumption is reversible: equip/unequip are free, the server rejects invalid ones (400/402/409).

const RARITY_RANK = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4, Mythic: 5 };
const STAGE_RANK = { Baby: 0, Juvenile: 1, Adult: 2, Elder: 3 };

// Numeric value of a relic by stats. Affixes are fractional boosts (hp_pct 0.11, crit_dmg 0.04…);
// summed with per-stat weights. Rarity / aura_tier / enhance are small tie-breakers so that at equal
// stat sums the objectively better item wins, but they DON'T override the stats themselves.
export function scoreRelic(relic, { weights = {} } = {}) {
  let s = 0;
  for (const a of relic?.affixes || []) {
    const w = weights[a.key] ?? 1;
    s += w * (Number(a.value) || 0);
  }
  s += (RARITY_RANK[relic?.rarity] ?? 0) * 1e-3;
  s += (Number(relic?.aura_tier) || 0) * 1e-4;
  s += (Number(relic?.enhance_level) || 0) * 1e-5;
  return s;
}

const equippable = (r, cls) =>
  r && r.class === cls && !r.listed && !r.stored && r.slot != null;

// Candidate carriers: strongest first (stage, then level) — they form the party for the deepest
// dungeons, so they get the best gear first.
function rankCreatures(creatures = []) {
  return creatures
    .filter(c => c && !c.listed && !c.stored)
    .slice()
    // id tie-break: the array order from /api/player/load changes between ticks — without a
    // deterministic order, creatures equal in stage/level swapped ranks, and the greedy plan handed out
    // the same relics differently every cycle (see the oscillation of 2026-07-05).
    .sort((a, b) => (STAGE_RANK[b.stage] ?? -1) - (STAGE_RANK[a.stage] ?? -1) || (b.level || 0) - (a.level || 0)
      || String(a.id).localeCompare(String(b.id)));
}

// Stickiness to the current carrier: moving a relic is only justified by a NOTICEABLE gain. Creature
// levels rise every tick → ranks keep shifting, and without hysteresis equivalent relics endlessly
// bounced between rank neighbours (24 relics doing 29-41 moves in 5h on Fury, 2026-07-05) — zero benefit
// to party_power, and equip/unequip spam is maximally bot-like.
const STICKINESS_MARGIN = 0.05; // keep the current relic unless it's worse than the best candidate by >5%

// Server cap of relics per creature. Confirmed from live dumps 2026-07-05 (Fury/Zephyr/main first-state):
// no creature carries more than 3, physical slots equip_slot=combat_a/b/c, and stat types mix freely.
// The old "one per stat type, no overall limit" model planned 10+ relics onto the top creature: the
// server replied 200 but didn't persist beyond three → each cycle the same equips "succeeded" again (the
// real source of relic churn, cured neither by the equip_slot fix nor the batch cap — those only limited
// the spam rate).
const MAX_RELICS_PER_CREATURE = 3;

// Plan the equipping. Returns { equip:[{relicId,target,slot}], unequip:[{relicId}] }.
// Greedy: for each creature (strongest first) and each slot, take the best relic not yet taken.
// Actions are minimal — if a relic is already correctly equipped, we emit nothing (idempotent per tick).
export function planRelicEquip(relics = [], creatures = [], {
  weights, equippableClass = 'combat', maxCreatures = Infinity,
} = {}) {
  const score = (r) => scoreRelic(r, { weights });
  // id tie-break — same principle as rankCreatures: relics equal in score must sort the same regardless
  // of the order of the relics array this tick.
  const pool = relics.filter(r => equippable(r, equippableClass))
    .sort((a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id)));
  const ranked = rankCreatures(creatures).slice(0, maxCreatures);

  const used = new Set();               // relics already assigned in this plan
  const equip = [];
  const unequip = [];
  const desiredHolder = new Map();      // relicId -> creatureId (final assignment)

  for (const cr of ranked) {
    const takenSlots = new Set();       // this creature's stat types already filled in the plan
    let assigned = 0;                   // server cap: no more than MAX_RELICS_PER_CREATURE per creature
    // Set-level stickiness: relics already worn on this creature get a score boost of STICKINESS_MARGIN
    // — a move/eviction only happens on a >5% gain, not on every equal-score dungeon drop or shift in
    // creature ranks (the source of the endless churn).
    const localPool = pool.slice().sort((a, b) => {
      const sa = score(a) * (a.equipped_on === cr.id ? 1 + STICKINESS_MARGIN : 1);
      const sb = score(b) * (b.equipped_on === cr.id ? 1 + STICKINESS_MARGIN : 1);
      return sb - sa || String(a.id).localeCompare(String(b.id));
    });
    for (const chosen of localPool) {
      if (assigned >= MAX_RELICS_PER_CREATURE) break; // creature is full — surplus goes to the next by rank
      if (used.has(chosen.id)) continue;
      const slot = chosen.slot;
      if (takenSlots.has(slot)) continue;         // slot already filled by a better relic (localPool is sorted)
      takenSlots.add(slot);
      used.add(chosen.id);
      desiredHolder.set(chosen.id, cr.id);
      assigned++;
      // 2026-07-06: was `&& relic.equip_slot === slot` — a BUG, found on live data. relic.slot is the
      // relic's stat type (e.g. "hp_pct", our field for the "one relic of this type per creature"
      // allocation), while relic.equip_slot is the server's physical slot (e.g. "combat_a", confirmed by
      // a real dump); they're from different dictionaries and NEVER match. The check was always false →
      // planRelicEquip didn't recognize already-equipped relics and re-equipped them EVERY cycle (~200
      // relic_equip/account in 20 min, down to zero dungeons on main/Fury — it ate the whole tick on
      // human-delay between actions). The only thing needed for idempotency is the same carrier.
      if (chosen.equipped_on === cr.id) continue; // already in place — no-op
      equip.push({ relicId: chosen.id, target: cr.id, slot });
    }
  }

  // Unequip relics that are currently worn but should move or free up in the new plan.
  // (equip onto the new target is done after unequip — the server may require a free slot.)
  for (const relic of relics) {
    if (!relic || relic.equipped_on == null) continue;
    if (!equippable(relic, equippableClass)) continue;
    const want = desiredHolder.get(relic.id);
    if (want !== relic.equipped_on) unequip.push({ relicId: relic.id });
  }

  return { equip, unequip };
}

// Trainer relics (Trainer Relic Forge, 2026-07-05): a SEPARATE system from pet relics — class≠'combat'
// (best-guess 'trainer', see NOTES/forgeRelicClass), a single "carrier" (the trainer/character, not a
// creature), fixed slots amulet/ring/idol, at most one relic per slot. Per the forge screenshot it's
// also 3 affixes, so scoreRelic (the weighted-affix sum) applies unchanged.
//
// "Is this relic equipped by anyone" is determined as tolerantly as possible across field-name variants
// (like isEquippedRelic in marketplace.js) — for class='trainer', equipped ALWAYS means "worn on the
// trainer" (the class doesn't overlap with creatures), so there's no need to match a specific trainer
// ID/address, whose format we don't know anyway.
const isEquippedAnywhere = (r) =>
  Boolean(r?.equipped === true || r?.equipped_on != null || r?.equippedOn != null
    || r?.equip_slot != null || r?.equipSlot != null);

// Plan the trainer's equipping. Returns { equip:[{relicId,slot}], unequip:[{relicId}] } — without a
// target (the trainer has one "recipient slot", unlike the many creatures). For each slot: among OUR
// trainer relics for that slot, take the best by stats; if it's already worn — no-op; if a different
// (worse) one is worn — unequip it and equip the best.
export function planTrainerRelicEquip(relics = [], {
  weights, trainerClass = 'trainer', slots = ['amulet', 'ring', 'idol'],
} = {}) {
  const score = (r) => scoreRelic(r, { weights });
  const pool = (relics || []).filter(r => r && r.class === trainerClass && !r.listed && !r.stored && r.slot != null);
  const equip = [];
  const unequip = [];
  for (const slot of slots) {
    const candidates = pool.filter(r => r.slot === slot);
    if (!candidates.length) continue;
    candidates.sort((a, b) => score(b) - score(a));
    const best = candidates[0];
    if (isEquippedAnywhere(best)) continue; // the best in this slot is already worn — idempotent
    const worn = candidates.find(r => r.id !== best.id && isEquippedAnywhere(r));
    if (worn) unequip.push({ relicId: worn.id });
    equip.push({ relicId: best.id, slot });
  }
  return { equip, unequip };
}
