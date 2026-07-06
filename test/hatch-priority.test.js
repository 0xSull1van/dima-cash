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
