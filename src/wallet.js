// Load/decrypt wallets and sign messages (ed25519, Solana format).
import { scryptSync, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_DIR = join(__dirname, '..', 'wallets');

// Decrypt a wallet from wallets/<name>.enc.json using the master key.
export function loadWallet(name, masterKey) {
  if (!masterKey) throw new Error('master key required (set ZENKO_MASTER_KEY)');
  const enc = JSON.parse(readFileSync(join(WALLET_DIR, `${name}.enc.json`), 'utf8'));
  const dk = scryptSync(masterKey, Buffer.from(enc.salt, 'base64'),
    enc.scrypt.keylen, { N: enc.scrypt.N, r: enc.scrypt.r, p: enc.scrypt.p, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', dk, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const secretKey = new Uint8Array(Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'base64')),
    decipher.final(),
  ]));
  return makeWallet(secretKey);
}

// Ephemeral wallet (for auth tests, no funds).
export function ephemeralWallet() {
  const kp = nacl.sign.keyPair.fromSeed(randomBytes(32));
  return makeWallet(kp.secretKey);
}

function makeWallet(secretKey /* Uint8Array 64 */) {
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
  const address = bs58.encode(kp.publicKey);
  return {
    address,
    secretKey: new Uint8Array(secretKey),
    // detached ed25519 signature → base58 (as in the game: d.A.encode(nacl.sign.detached(...)))
    signMessage(bytes /* Uint8Array */) {
      return bs58.encode(nacl.sign.detached(bytes, kp.secretKey));
    },
  };
}

export function walletSecretKeyBase58(wallet) {
  return bs58.encode(wallet.secretKey);
}
