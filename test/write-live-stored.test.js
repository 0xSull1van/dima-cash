import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZenkoBot } from '../src/bot.js';

// writeLive() writes to a hardcoded LOG_DIR (src/bot.js), not dependency-injected, so this is the
// only way to verify its real disk output — earlier tests always stubbed writeLive entirely. This
// field is safety-critical: `stored` is the ONLY telemetry surface that can confirm autoVaultWhenFull
// actually moved a creature to storage (see 2026-07-05 vault audit). Uses a throwaway account name
// and cleans up its own file so it never collides with or pollutes real fleet logs.
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const NAME = '__test_write_live_stored__';
const FILE = join(LOG_DIR, `live-${NAME}.json`);

test('writeLive exposes creature.stored so vault (autoVaultWhenFull) is verifiable from telemetry', () => {
  try {
    const bot = new ZenkoBot({ address: 'Test1111111111111111111111111111111111111' }, { name: NAME, ledger: false });
    bot.writeLive({
      player: { gold: 1000, zenko_balance: 0 },
      creatures: [
        { id: 'vaulted', species: 'florix', rarity: 'Rare', stage: 'Adult', level: 9, stored: true },
        { id: 'active', species: 'nimbu', rarity: 'Common', stage: 'Adult', level: 3, stored: false },
        { id: 'untouched', species: 'gusty', rarity: 'Common', stage: 'Adult', level: 2 }, // no stored field at all
      ],
      eggs: [], dungeonRuns: [], materials: [], relics: [],
    });
    assert.ok(existsSync(FILE), 'writeLive creates the live-<name>.json file');
    const written = JSON.parse(readFileSync(FILE, 'utf8'));
    const byId = Object.fromEntries(written.creaturesList.map(c => [c.id, c]));
    assert.equal(byId.vaulted.stored, true, 'stored:true creature is exposed as stored:true in creaturesList');
    assert.equal(byId.active.stored, false, 'stored:false creature is exposed as stored:false');
    assert.equal(byId.untouched.stored, false, 'creature with no stored field defaults to false (not undefined/omitted)');
  } finally {
    if (existsSync(FILE)) unlinkSync(FILE);
  }
});
