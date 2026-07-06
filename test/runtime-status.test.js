import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRuntimeStatuses, updateRuntimeStatus } from '../src/runtime-status.js';

test('runtime statuses are upserted by account name', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'zenko-runtime-'));
  try {
    updateRuntimeStatus('Zephyr', { status: 'funding', detail: 'queued' }, { logDir, now: () => 1000 });
    updateRuntimeStatus('Zephyr', { status: 'running', detail: 'bot online' }, { logDir, now: () => 2000 });

    const statuses = readRuntimeStatuses({ logDir });
    assert.deepEqual(statuses.Zephyr, {
      name: 'Zephyr',
      status: 'running',
      detail: 'bot online',
      updatedAt: 2000,
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
