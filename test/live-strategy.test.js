import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLiveStrategy } from '../src/live-strategy.js';

test('reads the last per-account dungeon strategy from a live snapshot', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'zenko-live-strategy-'));
  try {
    writeFileSync(join(logDir, 'live-Zephyr.json'), JSON.stringify({
      name: 'Zephyr',
      dungeon: { depth: 12, ceiling: 14, efficient: 10 },
    }), 'utf8');

    assert.deepEqual(readLiveStrategy('Zephyr', { logDir }), {
      depth: 12,
      depthCeiling: 14,
      efficientDepth: 10,
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('ignores missing or malformed live strategy', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'zenko-live-strategy-empty-'));
  try {
    assert.deepEqual(readLiveStrategy('Missing', { logDir }), {});
    writeFileSync(join(logDir, 'live-Bad.json'), JSON.stringify({
      dungeon: { depth: 'x', ceiling: 99, efficient: 0 },
    }), 'utf8');
    assert.deepEqual(readLiveStrategy('Bad', { logDir }), {});
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
