import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccounts, registryAccountNames } from '../src/account-creator.js';

test('creates encrypted wallets and registry records for nicknames', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-accounts-'));
  const walletDir = join(root, 'wallets');
  const registryPath = join(root, 'accounts.json');
  try {
    const result = createAccounts(['alpha', 'beta'], {
      masterKey: 'test-master-key',
      walletDir,
      registryPath,
      targetSolMin: 0.05,
      targetSolMax: 0.08,
      now: () => '2026-07-03T00:00:00.000Z',
    });

    assert.equal(result.created.length, 2);
    assert.equal(existsSync(join(walletDir, 'alpha.enc.json')), true);
    assert.equal(existsSync(join(walletDir, 'beta.enc.json')), true);

    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(registry.version, 1);
    assert.equal(registry.accounts.length, 2);
    assert.deepEqual(registry.accounts.map(account => account.name), ['alpha', 'beta']);
    assert.equal(registry.accounts[0].status, 'awaiting_deposit');
    assert.equal(registry.accounts[0].targetSolMin, 0.05);
    assert.equal(registry.accounts[0].targetSolMax, 0.08);
    assert.match(registry.accounts[0].address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(registry.accounts[0].walletFile, 'wallets/alpha.enc.json');

    const wallet = JSON.parse(readFileSync(join(walletDir, 'alpha.enc.json'), 'utf8'));
    assert.equal(wallet.pubkey, registry.accounts[0].address);
    assert.equal(typeof wallet.ciphertext, 'string');
    assert.equal(wallet.secretKey, undefined, 'plaintext private key must never be stored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses duplicate account names and unsafe path names', () => {
  assert.throws(() => createAccounts(['../bad'], {
    masterKey: 'test-master-key',
    walletDir: mkdtempSync(join(tmpdir(), 'zenko-unsafe-wallets-')),
    registryPath: join(mkdtempSync(join(tmpdir(), 'zenko-unsafe-reg-')), 'accounts.json'),
  }), /invalid account name/i);
});

test('does not overwrite existing wallet files', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-accounts-existing-'));
  const walletDir = join(root, 'wallets');
  const registryPath = join(root, 'accounts.json');
  try {
    const first = createAccounts(['alpha'], {
      masterKey: 'test-master-key',
      walletDir,
      registryPath,
      now: () => '2026-07-03T00:00:00.000Z',
    });
    const second = createAccounts(['alpha'], {
      masterKey: 'test-master-key',
      walletDir,
      registryPath,
      now: () => '2026-07-03T00:01:00.000Z',
    });

    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, 1);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(registry.accounts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registryAccountNames returns account names in registry order', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-accounts-registry-names-'));
  const walletDir = join(root, 'wallets');
  const registryPath = join(root, 'accounts.json');
  try {
    createAccounts(['alpha', 'beta'], {
      masterKey: 'test-master-key',
      walletDir,
      registryPath,
      now: () => '2026-07-03T00:00:00.000Z',
    });

    assert.deepEqual(registryAccountNames(registryPath), ['alpha', 'beta']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assigns proxies from pool to newly registered accounts', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-accounts-proxy-'));
  const walletDir = join(root, 'wallets');
  const registryPath = join(root, 'accounts.json');
  try {
    const result = createAccounts(['alpha', 'beta'], {
      masterKey: 'test-master-key',
      walletDir,
      registryPath,
      proxyPool: [
        'http://user:pass@198.37.116.236:6195',
        'http://user:pass@104.253.81.188:5616',
      ],
      now: () => '2026-07-03T00:00:00.000Z',
    });

    assert.equal(result.created[0].record.proxyEnv, 'ZENKO_PROXY_ALPHA');
    assert.equal(result.created[0].record.proxyUrl, 'http://user:pass@198.37.116.236:6195');
    assert.equal(result.created[1].record.proxyEnv, 'ZENKO_PROXY_BETA');
    assert.equal(result.created[1].record.proxyUrl, 'http://user:pass@104.253.81.188:5616');

    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.deepEqual(registry.accounts.map(account => account.proxyEnv), ['ZENKO_PROXY_ALPHA', 'ZENKO_PROXY_BETA']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registers existing wallet files with per-account proxy metadata when missing from registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-accounts-existing-proxy-'));
  const walletDir = join(root, 'wallets');
  const registryPath = join(root, 'accounts.json');
  try {
    const first = createAccounts(['main'], {
      masterKey: 'test-master-key',
      walletDir,
      registryPath,
      now: () => '2026-07-03T00:00:00.000Z',
    });
    writeFileSync(registryPath, JSON.stringify({ version: 1, accounts: [] }, null, 2));

    const result = createAccounts(['main'], {
      masterKey: 'test-master-key',
      walletDir,
      registryPath,
      proxyByName: {
        main: 'http://main.proxy:8080',
      },
      proxyPool: [
        'http://pool.proxy:8080',
      ],
      now: () => '2026-07-03T00:01:00.000Z',
    });

    assert.equal(result.created.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].record.proxyEnv, 'ZENKO_PROXY_MAIN');
    assert.equal(result.skipped[0].record.proxyUrl, 'http://main.proxy:8080');

    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(registry.accounts.length, 1);
    assert.equal(registry.accounts[0].address, first.created[0].pubkey);
    assert.equal(registry.accounts[0].proxyEnv, 'ZENKO_PROXY_MAIN');
    assert.equal(registry.accounts[0].proxyUrl, 'http://main.proxy:8080');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
