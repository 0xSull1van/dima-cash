import { randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

export const WALLET_SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export function encryptSecret(secretKey, masterKey, {
  randomBytesFn = randomBytes,
  scrypt = WALLET_SCRYPT,
} = {}) {
  if (!masterKey) throw new Error('master key required');
  const salt = randomBytesFn(16);
  const iv = randomBytesFn(12);
  const dk = scryptSync(masterKey, salt, scrypt.keylen, {
    N: scrypt.N,
    r: scrypt.r,
    p: scrypt.p,
    maxmem: scrypt.maxmem,
  });
  const cipher = createCipheriv('aes-256-gcm', dk, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'scrypt',
    scrypt: { N: scrypt.N, r: scrypt.r, p: scrypt.p, keylen: scrypt.keylen },
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ct.toString('base64'),
  };
}

export function generateEncryptedWallet(name, masterKey, {
  randomBytesFn = randomBytes,
  now = () => new Date().toISOString(),
} = {}) {
  const seed = randomBytesFn(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const pubkey = bs58.encode(kp.publicKey);
  const enc = encryptSecret(kp.secretKey, masterKey, { randomBytesFn });
  enc.name = name;
  enc.pubkey = pubkey;
  enc.createdAt = now();
  return { name, pubkey, enc };
}
