import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZenkoClient, isMaintenanceError } from '../src/client.js';
import { accountConfigsFromArgs, normalizeProxyUrl, proxyEnvName, proxyLabel } from '../src/accounts.js';

function wallet(address = 'Wallet111111111111111111111111111111111') {
  return {
    address,
    signMessage() { return 'signature'; },
  };
}

function loginFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const body = calls.length === 1
      ? { nonce: 'nonce-1' }
      : { token: 'token-1', expiresAt: Date.now() + 60_000 };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };
}

test('ZenkoClient sends every request through the configured proxy dispatcher', async () => {
  const calls = [];
  const dispatcher = { proxy: true };
  let proxyFactoryUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('global fetch should not be used in this test'); };
  try {
    const client = new ZenkoClient(wallet(), {
      base: 'https://example.test',
      fetchImpl: loginFetch(calls),
      proxyUrl: 'http://user:pass@proxy.local:8080',
      proxyAgentFactory: (url) => {
        proxyFactoryUrl = url;
        return dispatcher;
      },
    });

    await client.login();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(proxyFactoryUrl, 'http://user:pass@proxy.local:8080');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.dispatcher, dispatcher);
  assert.equal(calls[1].init.dispatcher, dispatcher);
});

// HANG FIX 2026-07-05: a stalled proxy/connection previously left `await fetch(...)` pending FOREVER
// (no AbortController), silently freezing the account's whole tick loop — no thrown error, so
// runForever()'s try/catch never fired, "tick error" never logged, next tick's sleep() never reached.
// Found live: 6/18 fleet accounts stale 5-13min with a dead-silent log. Fix: AbortController-based
// requestTimeoutMs on the whole request (fetch + body read).
test('ZenkoClient times out a request that never resolves (hung proxy) instead of hanging forever', async () => {
  const neverResolvingFetch = () => new Promise(() => {}); // simulates a dead/stalled proxy connection
  const client = new ZenkoClient(wallet(), {
    base: 'https://example.test',
    fetchImpl: neverResolvingFetch,
    requestTimeoutMs: 30, // short for test speed; production default is 30_000ms
  });

  const start = Date.now();
  await assert.rejects(
    () => client.api('/api/anything'),
    (e) => e.status === 0 && e.timeout === true,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `rejects promptly near the configured timeout, not hanging (took ${elapsed}ms)`);
});

test('ZenkoClient times out if fetch resolves but the response body read hangs', async () => {
  const hungBodyFetch = async () => ({
    ok: true,
    status: 200,
    text: () => new Promise(() => {}), // headers arrived, body stream stalls forever
  });
  const client = new ZenkoClient(wallet(), {
    base: 'https://example.test',
    fetchImpl: hungBodyFetch,
    requestTimeoutMs: 30,
  });

  await assert.rejects(
    () => client.api('/api/anything'),
    (e) => e.status === 0 && e.timeout === true,
    'a hang during body streaming (not just connect) also times out, not just the initial fetch()',
  );
});

test('isMaintenanceError detects the server-restart 503 body', () => {
  assert.equal(isMaintenanceError({ status: 503, bodyText: '{"error":"Restarting Server","maintenance":{"mode":"full"},"code":"MAINT_FULL"}' }), true);
  assert.equal(isMaintenanceError({ status: 503, bodyText: 'some other 503' }), false);
  assert.equal(isMaintenanceError({ status: 500, bodyText: 'maintenance' }), false);
});

test('ZenkoClient trips a maintenance backoff on 503 then fails fast without hitting the server', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/auth/nonce')) return { ok: true, status: 200, text: async () => JSON.stringify({ nonce: 'n' }) };
    if (url.endsWith('/api/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ token: 't', expiresAt: Date.now() + 60_000 }) };
    return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'Restarting Server', maintenance: { mode: 'full' }, code: 'MAINT' }) };
  };
  const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl });

  await assert.rejects(() => client.api('/api/player/load'), (e) => e.status === 503 && e.maintenance === true);
  assert.ok(client.maintenanceUntil > Date.now(), 'breaker armed after maintenance 503');
  const callsAfterTrip = calls.length; // nonce + login + player/load

  await assert.rejects(() => client.api('/api/anything'), (e) => e.status === 503 && e.maintenance === true);
  assert.equal(calls.length, callsAfterTrip, 'second call fails fast — no extra network hit while in maintenance');
});

// SESSION PERSISTENCE 2026-07-06 (owner: "софт полностью перезапускается и логины сбивает" — the
// token used to live ONLY in-memory on the ZenkoClient instance, so every process restart (including
// the new `node --watch` auto-restart-on-save from earlier this session) forced a fresh real
// /api/auth/login for every account, regardless of whether the previous 8h token had actually expired.
// More real login events than a genuine player ever produces is itself an anti-detection concern
// (hard constraint, see feedback_human_like_behavior), independent of whether the server enforces any
// rate limit. Fix: persist {token,expiresAt} to sessionPath; a fresh ZenkoClient instance restores it
// in the constructor, and ensureAuth() only calls the real login() when there genuinely is no valid
// token — restart no longer implies re-authentication.
function sessionCountingFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (String(url).endsWith('/api/auth/nonce')) return { ok: true, status: 200, text: async () => JSON.stringify({ nonce: 'n' }) };
    if (String(url).endsWith('/api/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'fresh-token', expiresAt: Date.now() + 8 * 60 * 60 * 1000 }) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
}

test('ZenkoClient: fresh instance with no sessionPath file logs in for real and persists the session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-session-'));
  try {
    const sessionPath = join(root, 'session-test.json');
    const calls = [];
    const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: sessionCountingFetch(calls), sessionPath });
    assert.equal(client.token, null, 'no persisted file yet — starts with no token');

    await client.ensureAuth();
    assert.equal(calls.length, 2, 'no valid token → real nonce+login network calls');
    assert.equal(client.token, 'fresh-token');

    const persisted = JSON.parse(readFileSync(sessionPath, 'utf8'));
    assert.equal(persisted.token, 'fresh-token', 'login() persisted the new token to disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZenkoClient: restores a still-valid session from sessionPath and skips real login entirely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-session-'));
  try {
    const sessionPath = join(root, 'session-test.json');
    writeFileSync(sessionPath, JSON.stringify({ token: 'old-but-valid', expiresAt: Date.now() + 60 * 60 * 1000 }));
    const calls = [];
    const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: sessionCountingFetch(calls), sessionPath });
    assert.equal(client.token, 'old-but-valid', 'constructor restores the token BEFORE ensureAuth is ever called — this is what a restart-survival check reads');

    await client.ensureAuth();
    assert.equal(calls.length, 0, 'valid restored token → ensureAuth makes ZERO network calls (this is the actual fix: no relogin on restart)');
    assert.equal(client.token, 'old-but-valid', 'kept the restored token, did not overwrite it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZenkoClient: an expired (or expiring within 60s) persisted session triggers a real relogin, not a silent reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-session-'));
  try {
    const sessionPath = join(root, 'session-test.json');
    writeFileSync(sessionPath, JSON.stringify({ token: 'about-to-expire', expiresAt: Date.now() + 10_000 })); // <60s left
    const calls = [];
    const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: sessionCountingFetch(calls), sessionPath });
    assert.equal(client.token, null, 'expiring-soon session is NOT restored — same 60s early-refresh margin as the existing ensureAuth() check');

    await client.ensureAuth();
    assert.equal(calls.length, 2, 'no usable token → real relogin happens, same as a brand-new account');
    assert.equal(client.token, 'fresh-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZenkoClient: a corrupt/unreadable sessionPath file is treated as "no session", never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-session-'));
  try {
    const sessionPath = join(root, 'session-test.json');
    writeFileSync(sessionPath, 'not valid json{{{');
    assert.doesNotThrow(() => {
      const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: sessionCountingFetch([]), sessionPath });
      assert.equal(client.token, null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZenkoClient: logout() clears the persisted session so a later restart cannot reuse a revoked token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-session-'));
  try {
    const sessionPath = join(root, 'session-test.json');
    const calls = [];
    const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: sessionCountingFetch(calls), sessionPath });
    await client.ensureAuth();
    assert.ok(existsSync(sessionPath), 'session persisted after login');

    await client.logout();
    assert.equal(existsSync(sessionPath), false, 'logout removes the persisted session file');
    assert.equal(client.token, null, 'logout clears the in-memory token too');

    // A fresh client instance pointed at the same (now-deleted) sessionPath must relogin for real,
    // not silently resurrect the revoked token from some stale in-memory or leftover state.
    const calls2 = [];
    const client2 = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: sessionCountingFetch(calls2), sessionPath });
    assert.equal(client2.token, null);
    await client2.ensureAuth();
    assert.equal(calls2.length, 2, 'post-logout restart performs a real relogin');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZenkoClient: sessionPath is fully opt-in — omitting it preserves the old in-memory-only behavior', async () => {
  const calls = [];
  const client = new ZenkoClient(wallet(), { base: 'https://example.test', fetchImpl: sessionCountingFetch(calls) }); // no sessionPath
  await client.ensureAuth();
  assert.equal(calls.length, 2, 'still logs in normally with no sessionPath configured');
  // no assertion on disk state possible/needed — this is exactly the pre-2026-07-06 behavior, used by
  // the one-off CLI scripts (bootstrap.js, market-smoke.js, probe*.js) that never pass sessionPath.
});

test('account configs map current account names to per-account proxy env vars', () => {
  const env = {
    ZENKO_PROXY_MAIN: 'http://main.proxy:8080',
    ZENKO_PROXY_SPARE: 'http://spare.proxy:8080',
  };

  assert.equal(proxyEnvName('main'), 'ZENKO_PROXY_MAIN');
  assert.deepEqual(accountConfigsFromArgs([], { env }), [
    { name: 'main', proxyUrl: 'http://main.proxy:8080' },
    { name: 'spare', proxyUrl: 'http://spare.proxy:8080' },
  ]);
  assert.deepEqual(accountConfigsFromArgs(['spare'], { env }), [
    { name: 'spare', proxyUrl: 'http://spare.proxy:8080' },
  ]);
});

test('normalizes provider proxy format host:port:user:pass into an HTTP proxy URL', () => {
  const raw = '198.37.116.236:6195:user:pass';
  const normalized = 'http://user:pass@198.37.116.236:6195';

  assert.equal(normalizeProxyUrl(raw), normalized);
  assert.deepEqual(accountConfigsFromArgs(['main'], { env: { ZENKO_PROXY_MAIN: raw } }), [
    { name: 'main', proxyUrl: normalized },
  ]);
  assert.equal(proxyLabel(raw), 'http://198.37.116.236:6195');
});

test('normalizes host:port proxy format without credentials', () => {
  assert.equal(normalizeProxyUrl('198.37.116.236:6195'), 'http://198.37.116.236:6195');
});

test('account configs can assign proxies from a pool file', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-proxy-pool-'));
  try {
    const proxyFile = join(root, 'proxies.txt');
    writeFileSync(proxyFile, [
      '198.37.116.236:6195:user:pass',
      '104.253.81.188:5616:user:pass',
    ].join('\n'));

    assert.deepEqual(accountConfigsFromArgs(['alpha', 'beta'], {
      env: { ZENKO_PROXY_POOL_FILE: proxyFile },
    }), [
      { name: 'alpha', proxyUrl: 'http://user:pass@198.37.116.236:6195' },
      { name: 'beta', proxyUrl: 'http://user:pass@104.253.81.188:5616' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-account proxy env overrides proxy pool assignment', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-proxy-pool-'));
  try {
    const proxyFile = join(root, 'proxies.txt');
    writeFileSync(proxyFile, '198.37.116.236:6195:user:pass\n');

    assert.deepEqual(accountConfigsFromArgs(['alpha'], {
      env: {
        ZENKO_PROXY_ALPHA: 'http://direct.proxy:8080',
        ZENKO_PROXY_POOL_FILE: proxyFile,
      },
    }), [
      { name: 'alpha', proxyUrl: 'http://direct.proxy:8080' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
