import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ZenkoBot } from '../src/bot.js';

test('writeLive persists frontend-safe raw state needed by web dashboard', () => {
  const name = `live-test-${process.pid}`;
  const file = join(process.cwd(), 'logs', `live-${name}.json`);
  rmSync(file, { force: true });
  const bot = new ZenkoBot({
    address: 'Live11111111111111111111111111111111111',
    wallet: {},
    api: async () => ({}),
  }, {
    name,
    ledger: false,
    persistStaminaPending: false,
  });

  try {
    bot.writeLive({
      player: { gold: 1, stamina: 2, zenko_balance: 3, place_slots: 8 },
      creatures: [{ id: 'c1', species: 'Alpha', stage: 'Adult', level: 7, status: 'Idle', xp: 11 }],
      dungeonRuns: [{ id: 'run1', status: 'ready', ready_at: '2026-01-01T00:00:00.000Z', party: ['c1'] }],
      eggs: [{ id: 'egg1', egg_type: 'basic', status: 'inventory' }],
      materials: [{ id: 'm1', type: 'ore', quantity: 2 }],
      relics: [{ id: 'r1', class: 'combat', slot: 'hp', equipped_on: 'c1', listed: false, stored: false }],
    });

    assert.equal(existsSync(file), true);
    const live = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(live.creaturesList[0].id, 'c1');
    assert.equal(live.dungeonRuns[0].id, 'run1');
    assert.equal(live.eggsList[0].id, 'egg1');
    assert.equal(live.materialsList[0].type, 'ore');
    assert.equal(live.relicsList[0].id, 'r1');
    assert.equal(live.zolanaHistory[0].zolana, 3);
    assert.equal(live.player.place_slots, 8);
  } finally {
    rmSync(file, { force: true });
  }
});
