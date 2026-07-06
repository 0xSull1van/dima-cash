import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { walletSecretKeyBase58 } from '../src/wallet.js';

const require = createRequire(import.meta.url);
const bs58 = require('bs58').default || require('bs58');

test('walletSecretKeyBase58 exports wallet secret key as base58', () => {
  const secretKey = Uint8Array.from([1, 2, 3, 4, 5]);
  assert.equal(walletSecretKeyBase58({ secretKey }), bs58.encode(secretKey));
});
