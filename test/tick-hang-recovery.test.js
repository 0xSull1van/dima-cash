import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoClient } from '../src/client.js';
import { ZenkoBot } from '../src/bot.js';

// PRODUCTION INCIDENT 2026-07-05: 6 of 18 fleet accounts went silent for 5-13min with a dead-flat
// log (no "tick error", no further activity) — every tick() opens with `await this.c.api('/api/player/load')`,
// and a stalled proxy left that fetch pending FOREVER (no timeout anywhere in the HTTP layer). Since
// nothing ever threw, runForever()'s try/catch never fired and the account's loop froze until the
// whole process was manually restarted. Fixed in client.js (#raw): AbortController + Promise.race
// timeout on the whole request. THIS test proves the fix at the layer that actually matters — a real
// ZenkoBot.tick() call, through a real ZenkoClient, must not hang past the configured timeout when the
// underlying transport stalls, and must surface a plain catchable error (what runForever's try/catch
// is built to handle) rather than hanging or crashing some other way.
function wallet() {
  return { address: 'Wallet111111111111111111111111111111111', signMessage: () => 'sig' };
}

test('ZenkoBot.tick() does not hang forever when the transport stalls on player/load', async () => {
  const neverResolvingFetch = () => new Promise(() => {}); // simulates the exact observed dead-proxy symptom
  const client = new ZenkoClient(wallet(), {
    base: 'https://example.test',
    fetchImpl: neverResolvingFetch,
    requestTimeoutMs: 30, // short for test speed; production default is 30_000ms
  });
  // pre-seed a token so tick() reaches the player/load call directly (skip login, which would hang too
  // for the same reason — already covered by client-proxy.test.js's own hang tests).
  client.token = 'seeded'; client.expiresAt = Date.now() + 60_000;

  const bot = new ZenkoBot(client, { name: 'hang-test', ledger: false });

  const start = Date.now();
  await assert.rejects(
    () => bot.tick(),
    (e) => e.status === 0 && e.timeout === true,
    'tick() propagates the timeout instead of hanging — this is exactly what runForever()\'s try/catch needs',
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `tick() returns near the configured timeout, not hanging indefinitely (took ${elapsed}ms)`);
});

test('after a timeout, a fresh tick() on the same bot succeeds once the transport recovers (self-healing)', async () => {
  let calls = 0;
  const flakyThenHealthyFetch = async (url) => {
    calls++;
    if (calls === 1) return new Promise(() => {}); // first call: simulate the stalled proxy
    // subsequent calls: transport recovered, respond normally
    if (String(url).endsWith('/api/player/load')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ player: { gold: 5, gems: 0, level: 1, xp: 0, stamina: 10 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: flakyThenHealthyFetch, requestTimeoutMs: 30 });
  client.token = 'seeded'; client.expiresAt = Date.now() + 60_000;
  const bot = new ZenkoBot(client, { name: 'hang-recover-test', ledger: false, afkZone: false, autoBuyEggs: false, autoEquipRelics: false, autoEvolve: false, autoBreed: false, feed: false });
  bot.handlePlacement = async () => {};
  bot.handleDungeons = async () => {};
  bot.handleClaims = async () => {};
  bot.handleRewards = async () => {};
  bot.writeLive = () => {};

  await assert.rejects(() => bot.tick(), (e) => e.timeout === true, 'first tick hangs-then-times-out (simulated stall)');
  const state = await bot.tick(); // this is exactly what runForever()'s next loop iteration would do
  assert.equal(state?.player?.gold, 5, 'the VERY NEXT tick succeeds once the transport recovers — the account self-heals, it does not stay dead');
});
