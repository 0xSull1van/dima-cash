// Zenko wallet generator.
// Generates a Solana-compatible keypair (ed25519, 64-byte secret = seed||pubkey),
// encrypts the secret with the master key (scrypt -> AES-256-GCM) and writes wallets/<name>.enc.json.
// ONLY the public key is returned to the outside. The secret hits disk only encrypted.
//
// IMPORTANT (security): the key is generated in this process, i.e. it existed in cleartext in memory
// during creation. Such a wallet = "hot", for small working amounts for the bot. For storage use a
// Phantom/hardware wallet where the seed never leaves you.
//
// Usage:
//   ZENKO_MASTER_KEY="<your-master-password>" node scripts/generate-wallet.js <name> [<name2> ...]
// If ZENKO_MASTER_KEY is not set — the script generates a random master key and prints it ONCE.
// Save it in a password manager: without it the encrypted wallets cannot be opened.

import { randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_DIR = join(__dirname, '..', 'wallets');

// scrypt params (interactive-strong). maxmem must exceed 128*N*r bytes.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function encryptSecret(secretKey /* Uint8Array 64 */, masterKey /* string */) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const dk = scryptSync(masterKey, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  const cipher = createCipheriv('aes-256-gcm', dk, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'scrypt',
    scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen },
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ct.toString('base64'),
  };
}

function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('Usage: node scripts/generate-wallet.js <name> [<name2> ...]');
    process.exit(1);
  }

  let masterKey = process.env.ZENKO_MASTER_KEY;
  let generatedMaster = false;
  if (!masterKey) {
    masterKey = bs58.encode(randomBytes(24)); // ~33 char base58 master key
    generatedMaster = true;
  }

  mkdirSync(WALLET_DIR, { recursive: true });

  const results = [];
  for (const name of names) {
    const outPath = join(WALLET_DIR, `${name}.enc.json`);
    if (existsSync(outPath)) {
      console.error(`SKIP: ${name}.enc.json already exists (refusing to overwrite)`);
      continue;
    }
    const seed = randomBytes(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);           // secretKey = seed||pubkey (Solana format)
    const pubkey = bs58.encode(kp.publicKey);
    const enc = encryptSecret(kp.secretKey, masterKey);
    enc.name = name;
    enc.pubkey = pubkey;
    enc.createdAt = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(enc, null, 2));
    results.push({ name, pubkey, file: outPath });
  }

  console.log('\n=== WALLETS CREATED ===');
  for (const r of results) {
    console.log(`  ${r.name.padEnd(12)} pub: ${r.pubkey}`);
  }
  if (generatedMaster) {
    console.log('\n=== MASTER KEY (save it, shown once) ===');
    console.log('  ' + masterKey);
    console.log('  Without it the encrypted wallets cannot be decrypted. Do NOT commit it to git.');
  }
  console.log('');
}

main();
