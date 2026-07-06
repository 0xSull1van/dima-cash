import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZenkoClient,
  isMaintenanceError,
  parseMaintenanceEtaMs,
  maintenanceWaitMs,
} from '../src/client.js';

// 2026-07-06 (owner: "during updates it should wait until the servers are back and not spam requests"):
// escalating maintenance backoff + ETA parsing so a long patch is waited out with a handful of probes.

function wallet() {
  return { address: 'W1111111111111111111111111111111111111', signMessage: () => 'sig' };
}

test('isMaintenanceError matches the game patch phrasings, not arbitrary 503s', () => {
  assert.equal(isMaintenanceError({ status: 503, bodyText: '{"error":"New Server + Bug Fixes. ETA 20-35 Min."}' }), true);
  assert.equal(isMaintenanceError({ status: 503, bodyText: '{"error":"Restarting Server","maintenance":{"mode":"full"}}' }), true);
  assert.equal(isMaintenanceError({ status: 503, bodyText: 'be right back' }), true);
  assert.equal(isMaintenanceError({ status: 503, bodyText: 'gateway timeout, unrelated' }), false, 'a generic 503 is NOT maintenance');
  assert.equal(isMaintenanceError({ status: 500, bodyText: 'maintenance' }), false, 'only 503');
});

test('parseMaintenanceEtaMs reads the LOW end of an ETA range', () => {
  assert.equal(parseMaintenanceEtaMs('New Server + Bug Fixes. ETA 20-35 Min.'), 20 * 60_000);
  assert.equal(parseMaintenanceEtaMs('ETA ~30 minutes'), 30 * 60_000);
  assert.equal(parseMaintenanceEtaMs('be right back in 15 minutes'), 15 * 60_000);
  assert.equal(parseMaintenanceEtaMs('Restarting Server'), null, 'no ETA → null');
  assert.equal(parseMaintenanceEtaMs('ETA 999 Min'), 60 * 60_000, 'a single ETA is capped at 60m for sanity');
});

test('maintenanceWaitMs escalates across consecutive hits and honours the ETA', () => {
  // no ETA → base 90s, then 3m, 6m, 10m, 10m… (base × 2^(streak-1), capped at 10m)
  assert.equal(maintenanceWaitMs(1, null), 90_000);
  assert.equal(maintenanceWaitMs(2, null), 180_000);
  assert.equal(maintenanceWaitMs(3, null), 360_000);
  assert.equal(maintenanceWaitMs(4, null), 600_000);
  assert.equal(maintenanceWaitMs(9, null), 600_000, 'capped at the 10m ceiling');
  // an ETA raises the FIRST wait to the ETA low-end (don't probe at 90s when told 20m)
  assert.equal(maintenanceWaitMs(1, 20 * 60_000), 20 * 60_000);
  // hard cap protects against a bogus huge combination
  assert.ok(maintenanceWaitMs(20, 60 * 60_000) <= 40 * 60_000);
});

test('client escalates maintenanceUntil across repeated maintenance hits, resets on success', async () => {
  let mode = 'maint';
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/auth/nonce')) return { ok: true, status: 200, text: async () => JSON.stringify({ nonce: 'n' }) };
    if (String(url).endsWith('/api/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ token: 't', expiresAt: Date.now() + 60 * 60_000 }) };
    if (mode === 'maint') return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'New Server + Bug Fixes. ETA 20-35 Min.' }) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const client = new ZenkoClient(wallet(), { base: 'https://ex.test', fetchImpl });

  // 1st hit: ETA 20m armed
  await assert.rejects(() => client.api('/api/player/load'), (e) => e.maintenance === true);
  assert.equal(client.maintenanceStreak, 1);
  assert.ok(client.maintenanceUntil - Date.now() >= 19 * 60_000, 'first wait ≈ the 20m ETA, not 90s');

  // force the breaker open (pretend the wait elapsed) so the next call actually probes the network again
  client.maintenanceUntil = 0;
  await assert.rejects(() => client.api('/api/player/load'), (e) => e.maintenance === true);
  assert.equal(client.maintenanceStreak, 2, 'consecutive hit increments the streak');

  // server comes back → next successful call resets the streak
  client.maintenanceUntil = 0;
  mode = 'up';
  await client.api('/api/player/load');
  assert.equal(client.maintenanceStreak, 0, 'a successful call resets the streak for the next patch');
});
