import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

test('shuffleSafeActions changes safe action order while keeping dungeon block in the middle', async () => {
  const state = {
    player: { gold: 0, gems: 0, level: 1, stamina: 180 },
    creatures: [],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  };
  const bot = new ZenkoBot({
    address: 'Test1111111111111111111111111111111111',
    wallet: {},
    api: async (path) => path === '/api/player/load' ? state : {},
  }, {
    name: 'flow',
    afkZone: false,
    ledger: false,
    persistStaminaPending: false,
    refreshLiveState: false,
    shuffleSafeActions: true,
    rng: () => 0,
  });
  const calls = [];
  bot.handleEggs = async () => calls.push('eggs');
  bot.handlePlacement = async () => calls.push('placement');
  bot.handleRelics = async () => calls.push('relics');
  bot.handleEvolve = async () => calls.push('evolve');
  bot.handleBreed = async () => calls.push('breed');
  bot.handleDungeons = async () => calls.push('dungeons');
  bot.handleFeeding = async () => calls.push('feeding');
  bot.handleClaims = async () => calls.push('claims');
  bot.handleRewards = async () => calls.push('rewards');

  await bot.tick();

  assert.deepEqual(calls, [
    'placement',
    'relics',
    'evolve',
    'breed',
    'eggs',
    'dungeons',
    'rewards',
    'feeding',
    'claims',
  ]);
});
