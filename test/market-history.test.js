import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFloorSnapshot, readFloorHistory } from '../src/market-history.js';

// 2026-07-06: the chart plots the MEDIAN clearing price (stable) instead of the raw min-floor (which
// whipsaws 15× on a thin market). appendFloorSnapshot records clearing; readFloorHistory exposes it.

test('appendFloorSnapshot records clearing; readFloorHistory exposes clearingZolana alongside floorZolana', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zenko-floor-'));
  try {
    appendFloorSnapshot('main', { common: 40, uncommon: 200 }, { common: 5, uncommon: 3 }, {
      logDir: dir, now: 1000, clearing: { common: 500, uncommon: 260 },
    });
    const pts = readFloorHistory({ logDir: dir, sinceMs: 0 });
    const common = pts.find(p => p.rarity === 'common');
    assert.equal(common.floorZolana, 40, 'min-floor preserved');
    assert.equal(common.clearingZolana, 500, 'median clearing recorded (the chart plots this)');
    assert.equal(common.saleCount, 5);
    const unc = pts.find(p => p.rarity === 'uncommon');
    assert.equal(unc.clearingZolana, 260);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readFloorHistory emits a point for a rarity that has clearing but no floor (and vice versa)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zenko-floor-'));
  try {
    // clearing-only (a rarity whose min-floor was 0/absent but a median exists)
    appendFloorSnapshot('a', {}, {}, { logDir: dir, now: 2000, clearing: { rare: 900 } });
    // floor-only (an OLD snapshot predating clearing)
    appendFloorSnapshot('b', { epic: 1500 }, { epic: 2 }, { logDir: dir, now: 3000 });
    const pts = readFloorHistory({ logDir: dir, sinceMs: 0 });
    const rare = pts.find(p => p.rarity === 'rare');
    assert.equal(rare.clearingZolana, 900);
    assert.equal(rare.floorZolana, 0, 'no floor → 0, but the point still exists (chart uses clearing)');
    const epic = pts.find(p => p.rarity === 'epic');
    assert.equal(epic.floorZolana, 1500);
    assert.equal(epic.clearingZolana, 0, 'old floor-only snapshot → chart falls back to floor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
