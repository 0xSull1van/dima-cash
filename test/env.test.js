import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertEnvFile } from '../src/env.js';

test('upsertEnvFile updates and appends keys without dropping existing env', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenko-env-'));
  const envPath = join(root, '.env');
  try {
    writeFileSync(envPath, 'SOLANA_RPC_URL=https://rpc.example\nZENKO_PROXY_ALPHA=old\n');

    upsertEnvFile(envPath, {
      ZENKO_PROXY_ALPHA: 'http://proxy-a:8080',
      ZENKO_PROXY_BETA: 'http://proxy-b:8080',
    });

    const text = readFileSync(envPath, 'utf8');
    assert.match(text, /^SOLANA_RPC_URL=https:\/\/rpc\.example$/m);
    assert.match(text, /^ZENKO_PROXY_ALPHA=http:\/\/proxy-a:8080$/m);
    assert.match(text, /^ZENKO_PROXY_BETA=http:\/\/proxy-b:8080$/m);
    assert.equal((text.match(/^ZENKO_PROXY_ALPHA=/gm) || []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
