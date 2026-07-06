// Расшифровка кошелька: ZENKO_MASTER_KEY + wallets/<name>.enc.json -> секретный ключ.
// По умолчанию печатает ТОЛЬКО pubkey (безопасно проверить). Секрет выводит лишь с --reveal.
//
//   ZENKO_MASTER_KEY="..." node scripts/decrypt-wallet.js <name>            # только pubkey
//   ZENKO_MASTER_KEY="..." node scripts/decrypt-wallet.js <name> --reveal   # + secret (base58 + JSON array)

import { scryptSync, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bs58 = require('bs58').default || require('bs58');

const __dirname = dirname(fileURLToPath(import.meta.url));

export function decryptWallet(name, masterKey) {
  const path = join(__dirname, '..', 'wallets', `${name}.enc.json`);
  const enc = JSON.parse(readFileSync(path, 'utf8'));
  const dk = scryptSync(masterKey, Buffer.from(enc.salt, 'base64'),
    enc.scrypt.keylen, { N: enc.scrypt.N, r: enc.scrypt.r, p: enc.scrypt.p, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', dk, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const secret = Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return { secretKey: new Uint8Array(secret), pubkey: enc.pubkey };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('decrypt-wallet.js')) {
  const name = process.argv[2];
  const reveal = process.argv.includes('--reveal');
  const masterKey = process.env.ZENKO_MASTER_KEY;
  if (!name || !masterKey) {
    console.error('Usage: ZENKO_MASTER_KEY="..." node scripts/decrypt-wallet.js <name> [--reveal]');
    process.exit(1);
  }
  try {
    const { secretKey, pubkey } = decryptWallet(name, masterKey);
    console.log('pubkey:', pubkey);
    if (reveal) {
      console.log('secret (base58):', bs58.encode(secretKey));
      console.log('secret (json array):', JSON.stringify(Array.from(secretKey)));
    } else {
      console.log('(decrypt OK — pass --reveal to print the secret key)');
    }
  } catch (e) {
    console.error('DECRYPT FAILED (wrong master key or corrupt file):', e.message);
    process.exit(1);
  }
}
