import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

// 2026-07-06 (owner: "incubation isn't claiming, pets aren't being added"): on a full roster, graduate
// (vault→active) and intake (active→vault) cancelled out, so no active slot freed and ready eggs couldn't
// hatch. Fix: when the roster is full AND eggs are ready, SKIP graduate so intake net-frees a hatch slot.
function makeBot(cfg = {}) {
  const bot = new ZenkoBot({ address: 'Hatch111111111111111111111111111111111', wallet: {}, api: async () => ({}) }, {
    name: 'hatch', ledger: false, persistStaminaPending: false,
    autoRecycleCreatures: false, autoVaultWhenFull: false, autoVaultSwap: false,
    autoBreedingPipeline: true,
    ...cfg,
  });
  // stub the neighbouring valves + dispatch so only the graduate/intake ordering is exercised
  bot.handleRecycle = async () => false;
  bot.handleVault = async () => false;
  bot.handleVaultSwap = async () => false;
  bot.hatchReadyEggs = async () => ({ hatched: 0 });
  bot.maybeProbeDeeper = async (s) => s;
  bot.dispatchRuns = async () => 0;
  return bot;
}

test('skips graduate when roster is full AND eggs are ready (intake frees the hatch slot instead)', async () => {
  const bot = makeBot({ vaultRosterFull: 3 });
  let graduate = false, intake = false;
  bot.handleVaultGraduate = async () => { graduate = true; return false; };
  bot.handleVaultIntake = async () => { intake = true; return false; };

  await bot.handleDungeons({
    player: { gold: 0, stamina: 0 },
    creatures: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], // roster 3 >= vaultRosterFull 3 → FULL
    eggs: [{ id: 'e1', status: 'ready' }],              // a ready egg is waiting
    dungeonRuns: [],
  });

  assert.equal(graduate, false, 'graduate is skipped (it would refill the slot intake frees)');
  assert.equal(intake, true, 'intake still runs to net-free an active slot for the hatch');
});

test('runs graduate normally when the roster has room (no cancellation risk)', async () => {
  const bot = makeBot({ vaultRosterFull: 10 });
  let graduate = false;
  bot.handleVaultGraduate = async () => { graduate = true; return false; };
  bot.handleVaultIntake = async () => false;

  await bot.handleDungeons({
    player: { gold: 0, stamina: 0 },
    creatures: [{ id: 'a' }], // roster 1 < vaultRosterFull 10 → has room
    eggs: [{ id: 'e1', status: 'ready' }],
    dungeonRuns: [],
  });

  assert.equal(graduate, true, 'graduate runs normally to drain exhausted breeders → sale');
});

test('runs graduate when the roster is full but NO eggs are ready (nothing to prioritize)', async () => {
  const bot = makeBot({ vaultRosterFull: 3 });
  let graduate = false;
  bot.handleVaultGraduate = async () => { graduate = true; return false; };
  bot.handleVaultIntake = async () => false;

  await bot.handleDungeons({
    player: { gold: 0, stamina: 0 },
    creatures: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], // full
    eggs: [{ id: 'e1', status: 'incubating', hatch_ready_at: '2999-01-01T00:00:00Z' }], // not ready yet
    dungeonRuns: [],
  });

  assert.equal(graduate, true, 'no ready eggs → graduate runs (no hatch to prioritize)');
});

// 2026-07-06 (owner: "не клеймятся петты / инкубация зависла" #2 — Nova/Ember stuck 30min): the valves burn
// their 5-15/3-8min cooldown even on a MISS, so on a fully-dispatched full-roster account they never catch a
// free creature to free a slot. When eggs are blocked, zero the vault+intake cooldowns → retry every tick.
test('eggs blocked behind a full roster → vault + intake cooldowns are zeroed (retry every tick)', async () => {
  const bot = makeBot({ vaultRosterFull: 3, vaultBreedingPoolTarget: 10 });
  bot.handleVaultGraduate = async () => false;
  bot.handleVaultIntake = async () => false; // stubbed so it doesn't re-arm the cooldown (real one would)
  const future = Date.now() + 999999;
  bot.nextVaultAt = future; bot.nextVaultIntakeAt = future;

  await bot.handleDungeons({
    player: { gold: 0, stamina: 0 },
    creatures: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], // roster 3 >= 3 → FULL
    eggs: [{ id: 'e1', status: 'ready' }],
    dungeonRuns: [],
  });

  assert.equal(bot.nextVaultAt, 0, 'pressure-valve cooldown zeroed so it retries this tick');
  assert.equal(bot.nextVaultIntakeAt, 0, 'intake cooldown zeroed so it retries this tick');
});

test('roster has room → cooldowns are NOT reset (normal human cadence preserved)', async () => {
  const bot = makeBot({ vaultRosterFull: 10 });
  bot.handleVaultGraduate = async () => false;
  bot.handleVaultIntake = async () => false;
  const future = Date.now() + 999999;
  bot.nextVaultAt = future; bot.nextVaultIntakeAt = future;

  await bot.handleDungeons({
    player: { gold: 0, stamina: 0 },
    creatures: [{ id: 'a' }], // roster 1 < 10 → room
    eggs: [{ id: 'e1', status: 'ready' }],
    dungeonRuns: [],
  });

  assert.equal(bot.nextVaultAt, future, 'cooldown untouched when not blocked');
  assert.equal(bot.nextVaultIntakeAt, future, 'intake cooldown untouched when not blocked');
});

// The every-tick intake can fill the vault to its target fast; if BOTH roster and vault are full, skipping
// graduate would deadlock (intake can't move anything in). So graduate must run to drain the vault.
test('vault ALSO full + eggs blocked → graduate RUNS (drains vault, avoids roster+vault deadlock)', async () => {
  const bot = makeBot({ vaultRosterFull: 3, vaultBreedingPoolTarget: 2, vaultBreedingRarities: ['uncommon'] });
  let graduate = false;
  bot.handleVaultGraduate = async () => { graduate = true; return false; };
  bot.handleVaultIntake = async () => false;

  await bot.handleDungeons({
    player: { gold: 0, stamina: 0 },
    creatures: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],       // roster 3 = full
    stored: { creatures: [                                     // vault pool 2 >= target 2 → vault FULL
      { id: 'v1', rarity: 'uncommon', breed_count: 0, stored: true },
      { id: 'v2', rarity: 'uncommon', breed_count: 0, stored: true },
    ] },
    eggs: [{ id: 'e1', status: 'ready' }],
    dungeonRuns: [],
  });

  assert.equal(graduate, true, 'vault full → graduate drains it instead of being skipped');
});
