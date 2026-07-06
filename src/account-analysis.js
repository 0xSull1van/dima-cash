const STAGE_RANK = { Baby: 0, Juvenile: 1, Adult: 2, Elder: 3 };
const DEFAULT_CAPS = {
  creatureTarget: 105,
  eggQueueTarget: 4,
  dungeonMax: 25,
  staminaMax: 180,
  heroLevelTarget: 100,
};

const isActiveRun = (run) => run && run.status !== 'claimed' && run.status !== 'done';
const parseTime = (value) => (value ? Date.parse(value) : 0);
const asArray = (value) => Array.isArray(value) ? value : [];

function isReadyRun(run, now = Date.now()) {
  if (!isActiveRun(run)) return false;
  const readyAt = run.ready_at || run.ends_at;
  return run.status === 'ready' || Boolean(readyAt && parseTime(readyAt) <= now);
}

function creatureScore(creature) {
  return [
    STAGE_RANK[creature?.stage] ?? -1,
    Number(creature?.level) || 0,
    Number(creature?.xp) || 0,
  ];
}

function compareCreatures(a, b) {
  const sa = creatureScore(a);
  const sb = creatureScore(b);
  for (let i = 0; i < sa.length; i++) {
    const diff = sb[i] - sa[i];
    if (diff) return diff;
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function busyCreatureIds(state) {
  const ids = new Set();
  for (const run of state.dungeonRuns || []) {
    if (!isActiveRun(run)) continue;
    for (const id of run.party || []) ids.add(id);
  }
  for (const creature of state.creatures || []) {
    if (creature.status === 'Busy' || creature.status === 'In a dungeon') ids.add(creature.id);
  }
  return ids;
}

function summarizeMaterials(materials = []) {
  const counts = new Map();
  for (const item of materials) {
    const name = item?.type || item?.material || item?.name || item?.id || 'unknown';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function heroLabel(hero) {
  if (!hero) return null;
  const name = hero.species || hero.creature_id || hero.id;
  const stage = hero.stage || 'Unknown';
  const level = hero.level ?? '?';
  return `${name} ${stage} lvl ${level}`;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function ratePerHour(history = [], key) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const normalized = history
    .map(point => ({ t: Number(point.t), value: Number(point[key]) }))
    .filter(point => Number.isFinite(point.t) && Number.isFinite(point.value))
    .sort((a, b) => a.t - b.t);
  if (normalized.length < 2) return null;
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  const hours = (last.t - first.t) / 3.6e6;
  if (hours <= 0.02) return null;
  return Math.round(((last.value - first.value) / hours) * 100) / 100;
}

function progressSummary({ player, creatures, pendingEggs, relicEquipped, dungeon, caps, hero }) {
  const placed = creatures.filter(creature => creature.plot_x != null || creature.placed).length;
  const placeSlots = Number(player.place_slots || player.placeSlots || player.max_place_slots || 0);
  const currentRelicSlots = Math.max(1, Math.min(creatures.length * 3, caps.creatureTarget * 3));
  const stageProgress = hero ? (STAGE_RANK[hero.stage] ?? 0) / 3 : 0;
  const levelProgress = hero ? (Number(hero.level) || 0) / caps.heroLevelTarget : 0;
  const components = {
    roster: clamp01(creatures.length / caps.creatureTarget),
    placement: clamp01(placed / Math.max(1, placeSlots || creatures.length || 1)),
    eggs: clamp01(pendingEggs / caps.eggQueueTarget),
    dungeon: clamp01((Number(dungeon?.ceiling || dungeon?.depth || 1) || 1) / caps.dungeonMax),
    relics: clamp01(relicEquipped / currentRelicSlots),
    hero: clamp01((stageProgress * 0.7) + (levelProgress * 0.3)),
  };
  const weights = { roster: 0.22, placement: 0.10, eggs: 0.10, dungeon: 0.24, relics: 0.16, hero: 0.18 };
  const raw = Object.entries(weights).reduce((sum, [key, weight]) => sum + components[key] * weight, 0);
  return { percent: Math.round(raw * 100), components };
}

export function analyzeAccountState(state = {}, {
  name = '',
  address = '',
  priceUsd = 0,
  partySize = 3,
  caps: capsInput = {},
} = {}) {
  const caps = { ...DEFAULT_CAPS, ...(state.caps || {}), ...capsInput };
  const player = state.player || {};
  const creatures = asArray(state.creatures).length ? asArray(state.creatures) : asArray(state.creaturesList);
  const runs = asArray(state.dungeonRuns).filter(isActiveRun);
  const readyRuns = runs.filter(run => isReadyRun(run));
  const busy = busyCreatureIds(state);
  const idleCreatures = creatures.filter(creature => !busy.has(creature.id));
  const ranked = creatures.slice().sort(compareCreatures);
  const hero = ranked[0] || null;
  const relicList = asArray(state.relicsList).length ? asArray(state.relicsList) : asArray(state.relics);
  const combatRelics = relicList.filter(relic => relic?.class === 'combat');
  const freeCombatRelics = combatRelics.filter(relic =>
    relic.equipped_on == null && !relic.listed && !relic.stored && relic.slot != null);
  const eggs = asArray(state.eggsList).length ? asArray(state.eggsList) : asArray(state.eggs);
  const pendingEggs = eggs.filter(egg => egg.status !== 'hatched');
  const materialList = asArray(state.materialsList).length ? asArray(state.materialsList) : asArray(state.materials);
  const topMaterials = summarizeMaterials(materialList);
  const holdingsUsd = priceUsd ? Number(((player.zenko_balance || 0) * priceUsd).toFixed(2)) : null;
  const relicEquipped = relicList.filter(relic => relic?.equipped_on != null).length || state.relics?.equipped || 0;
  const progress = progressSummary({
    player,
    creatures,
    pendingEggs: pendingEggs.length || state.counts?.pendingEggs || 0,
    relicEquipped,
    dungeon: state.dungeon || {},
    caps,
    hero,
  });

  const recommendations = [];
  if (readyRuns.length) recommendations.push(`Claim ${readyRuns.length} ready dungeon run(s).`);
  const fullParties = Math.floor(idleCreatures.length / partySize);
  if (fullParties) recommendations.push(`Dispatch ${fullParties} full idle dungeon party/parties.`);
  if (freeCombatRelics.length) recommendations.push(`Equip ${freeCombatRelics.length} free combat relic(s).`);
  if (pendingEggs.length) recommendations.push(`Process ${pendingEggs.length} pending egg(s).`);
  if (!recommendations.length) recommendations.push('No immediate idle work detected.');

  return {
    name,
    address,
    player: {
      level: player.level,
      gold: player.gold,
      gems: player.gems,
      stamina: player.stamina,
      zolana: player.zenko_balance,
    },
    pnl: {
      holdingsUsd,
      priceUsd: priceUsd || null,
    },
    rates: {
      goldPerHour: ratePerHour(state.goldHistory, 'gold'),
      zolanaPerHour: ratePerHour(state.zolanaHistory, 'zolana'),
      petValueZolanaPerHour: ratePerHour(state.petValueHistory, 'zolana'), // unbound-sellable pet value/h
      petValueAllPerHour: ratePerHour(state.petValueHistory, 'all'),       // mark-to-market pet value/h
    },
    caps,
    progress,
    hero: hero ? {
      id: hero.id,
      label: heroLabel(hero),
      species: hero.species || hero.creature_id,
      rarity: hero.rarity,
      variant: hero.variant,
      stage: hero.stage,
      level: hero.level,
      placed: hero.plot_x != null,
    } : null,
    dungeon: {
      activeRuns: runs.length,
      readyRuns: readyRuns.length,
      idleCreatures: idleCreatures.length,
      fullParties,
      nextReadyAt: runs
        .map(run => run.ready_at || run.ends_at)
        .filter(Boolean)
        .sort()[0] || null,
    },
    relics: {
      total: relicList.length || state.relics?.total || 0,
      combat: combatRelics.length,
      equipped: relicEquipped,
      freeCombat: freeCombatRelics.length,
    },
    loot: {
      materials: materialList.length || state.counts?.mats || 0,
      topMaterials: topMaterials.slice(0, 5),
    },
    eggs: {
      total: eggs.length || state.counts?.eggs || 0,
      pending: pendingEggs.length || state.counts?.pendingEggs || 0,
    },
    recommendations,
  };
}
