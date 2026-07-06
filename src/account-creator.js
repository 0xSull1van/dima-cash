import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { generateEncryptedWallet } from './wallet-generator.js';
import { proxyEnvName } from './accounts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WALLET_DIR = join(__dirname, '..', 'wallets');
export const DEFAULT_REGISTRY_PATH = join(__dirname, '..', 'accounts.json');

export function validateAccountName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw new Error(`invalid account name: ${name}`);
  }
  return value;
}

export function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  if (!existsSync(registryPath)) return { version: 1, accounts: [] };
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(registry.accounts)) registry.accounts = [];
  if (!registry.version) registry.version = 1;
  return registry;
}

export function registryAccountNames(registryPath = DEFAULT_REGISTRY_PATH) {
  return loadRegistry(registryPath).accounts
    .map(account => account.name)
    .filter(Boolean);
}

export function saveRegistry(registry, registryPath = DEFAULT_REGISTRY_PATH, { now = () => new Date().toISOString() } = {}) {
  registry.version = registry.version || 1;
  registry.updatedAt = now();
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

function walletFileRelative(walletDir, name) {
  return `wallets/${name}.enc.json`;
}

function walletFilePath(walletDir, name) {
  const path = join(walletDir, `${name}.enc.json`);
  const rel = relative(walletDir, path);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error(`unsafe wallet path for ${name}`);
  return path;
}

function readExistingPubkey(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).pubkey || null;
  } catch {
    return null;
  }
}

function upsertRegistryAccount(registry, record) {
  const existing = registry.accounts.find(account => account.name === record.name);
  if (existing) return existing;
  registry.accounts.push(record);
  return record;
}

function proxyForAccount(name, { proxyByName, proxyPool, index }) {
  const direct = proxyByName[name];
  if (direct) return { proxyUrl: direct, fromPool: false };
  if (!proxyPool.length) return { proxyUrl: null, fromPool: false };
  return { proxyUrl: proxyPool[index % proxyPool.length], fromPool: true };
}

function attachProxy(record, name, proxyUrl) {
  if (!proxyUrl) return record;
  record.proxyEnv = proxyEnvName(name);
  record.proxyUrl = proxyUrl;
  return record;
}

export function createAccounts(names, {
  masterKey,
  walletDir = DEFAULT_WALLET_DIR,
  registryPath = DEFAULT_REGISTRY_PATH,
  targetSolMin = 0.05,
  targetSolMax = 0.08,
  proxyByName = {},
  proxyPool = [],
  now = () => new Date().toISOString(),
} = {}) {
  if (!masterKey) throw new Error('master key required');
  const safeNames = names.map(validateAccountName);
  const uniqueNames = [...new Set(safeNames)];
  mkdirSync(walletDir, { recursive: true });

  const registry = loadRegistry(registryPath);
  const created = [];
  const skipped = [];
  let nextProxyIndex = registry.accounts.length;

  for (const name of uniqueNames) {
    const outPath = walletFilePath(walletDir, name);
    const existingRegistry = registry.accounts.find(account => account.name === name);
    if (existsSync(outPath) || existingRegistry) {
      const pubkey = existingRegistry?.address || readExistingPubkey(outPath);
      let record = existingRegistry || null;
      const proxy = proxyForAccount(name, { proxyByName, proxyPool, index: nextProxyIndex });
      if (pubkey && !existingRegistry) {
        record = {
          name,
          address: pubkey,
          walletFile: walletFileRelative(walletDir, name),
          status: 'awaiting_deposit',
          targetSolMin,
          targetSolMax,
          createdAt: now(),
        };
        attachProxy(record, name, proxy.proxyUrl);
        upsertRegistryAccount(registry, record);
        if (proxy.fromPool) nextProxyIndex += 1;
      } else if (record && proxy.proxyUrl && (!record.proxyEnv || !record.proxyUrl)) {
        attachProxy(record, name, proxy.proxyUrl);
        if (proxy.fromPool) nextProxyIndex += 1;
      }
      skipped.push({ name, pubkey, reason: 'exists', record });
      continue;
    }

    const proxy = proxyForAccount(name, { proxyByName, proxyPool, index: nextProxyIndex });
    const proxyUrl = proxy.proxyUrl;
    const proxyEnv = proxyUrl ? proxyEnvName(name) : null;
    if (proxy.fromPool) nextProxyIndex += 1;

    const wallet = generateEncryptedWallet(name, masterKey, { now });
    writeFileSync(outPath, JSON.stringify(wallet.enc, null, 2));
    const record = {
      name,
      address: wallet.pubkey,
      walletFile: walletFileRelative(walletDir, name),
      status: 'awaiting_deposit',
      targetSolMin,
      targetSolMax,
      createdAt: now(),
    };
    if (proxyUrl) {
      record.proxyEnv = proxyEnv;
      record.proxyUrl = proxyUrl;
    }
    upsertRegistryAccount(registry, record);
    created.push({ name, pubkey: wallet.pubkey, file: outPath, record });
  }

  saveRegistry(registry, registryPath, { now });
  return { created, skipped, registry };
}
