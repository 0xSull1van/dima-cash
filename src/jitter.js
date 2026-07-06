export function hashSeed(input) {
  let h = 2166136261;
  for (const ch of String(input)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRandom(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBetween(rng, min, max) {
  return min + rng() * (max - min);
}

export function randomInt(rng, min, max) {
  return Math.floor(randomBetween(rng, min, max + 1));
}

export function shuffleWithRng(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function createAccountJitterProfile(name, { index = 0, runSeed = Date.now() } = {}) {
  const seed = `${runSeed}:${index}:${name}`;
  const rng = seededRandom(seed);
  const tickMinSec = randomInt(rng, 60, 120);
  return {
    seed,
    bootDelayMs: randomInt(rng, 0, 180_000),
    actionDelayMinMs: randomInt(rng, 600, 2_500),
    actionDelayMaxMs: randomInt(rng, 3_300, 6_500),
    tickMinSec,
    tickMaxSec: randomInt(rng, tickMinSec + 60, 300),
  };
}
