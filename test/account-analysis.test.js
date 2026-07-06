import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAccountState } from '../src/account-analysis.js';

test('summarizes hero, dungeon capacity, relics, loot, and next actions', () => {
  const state = {
    player: { level: 5, gold: 12_000, gems: 3, stamina: 42, zenko_balance: 100 },
    creatures: [
      { id: 'c0', species: 'A', stage: 'Adult', level: 9, plot_x: 1 },
      { id: 'c1', species: 'B', stage: 'Elder', level: 2 },
      { id: 'c2', species: 'C', stage: 'Adult', level: 4, status: 'Busy' },
      { id: 'c3', species: 'D', stage: 'Juvenile', level: 8 },
      { id: 'c4', species: 'E', stage: 'Adult', level: 1 },
      { id: 'c5', species: 'F', stage: 'Adult', level: 1 },
    ],
    dungeonRuns: [
      { id: 'r0', status: 'ready', party: ['c2'] },
      { id: 'r1', status: 'running', ready_at: new Date(Date.now() + 60_000).toISOString(), party: ['c3'] },
    ],
    relics: [
      { id: 'r0', class: 'combat', equipped_on: 'c1' },
      { id: 'r1', class: 'combat', equipped_on: null, listed: false, stored: false, slot: 'hp' },
      { id: 'r2', class: 'cosmetic', equipped_on: null },
    ],
    eggs: [{ status: 'inventory' }, { status: 'hatched' }],
    materials: [{ type: 'ore' }, { type: 'ore' }, { material: 'wood' }],
    zolanaHistory: [{ t: 0, zolana: 10 }, { t: 60 * 60 * 1000, zolana: 25 }],
    dungeon: { ceiling: 10 },
  };

  const summary = analyzeAccountState(state, { name: 'main', address: 'abcdef123456', priceUsd: 0.5 });

  assert.equal(summary.hero.id, 'c1');
  assert.equal(summary.hero.label, 'B Elder lvl 2');
  assert.equal(summary.dungeon.activeRuns, 2);
  assert.equal(summary.dungeon.readyRuns, 1);
  assert.equal(summary.dungeon.idleCreatures, 4);
  assert.equal(summary.dungeon.fullParties, 1);
  assert.equal(summary.relics.freeCombat, 1);
  assert.deepEqual(summary.loot.topMaterials[0], { name: 'ore', count: 2 });
  assert.ok(summary.recommendations.includes('Claim 1 ready dungeon run(s).'));
  assert.ok(summary.recommendations.includes('Dispatch 1 full idle dungeon party/parties.'));
  assert.equal(summary.pnl.holdingsUsd, 50);
  assert.equal(summary.rates.zolanaPerHour, 15);
  assert.ok(summary.progress.percent > 0);
  assert.equal(summary.caps.eggQueueTarget, 4);
});
