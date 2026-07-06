import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_ACCOUNT_NAMES = ['main', 'spare'];

export function proxyEnvName(accountName) {
  const key = String(accountName || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `ZENKO_PROXY_${key}`;
}

export function accountConfigsFromArgs(args = [], { env = process.env, defaultNames = DEFAULT_ACCOUNT_NAMES, cwd = process.cwd() } = {}) {
  const names = args.filter(Boolean).filter(arg => !String(arg).startsWith('--'));
  const selected = names.length > 0 ? names : defaultNames;
  const proxyPool = loadProxyPool(env, { cwd });
  return selected.map((name, index) => ({
    name,
    proxyUrl: proxyUrlForAccount(name, env, { poolProxyUrl: proxyPool[index % proxyPool.length] }),
  }));
}

export function proxyUrlForAccount(accountName, env = process.env, { poolProxyUrl = null } = {}) {
  const own = env[proxyEnvName(accountName)];
  const fallback = env.ZENKO_PROXY_URL;
  const proxy = String(own || fallback || poolProxyUrl || '').trim();
  return normalizeProxyUrl(proxy);
}

export function loadProxyPool(env = process.env, { cwd = process.cwd() } = {}) {
  const poolFile = String(env.ZENKO_PROXY_POOL_FILE || '').trim();
  if (!poolFile) return [];

  const filePath = resolve(cwd, poolFile);
  if (!existsSync(filePath)) return [];

  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(normalizeProxyUrl);
}

export function proxyLabel(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return 'direct';
  try {
    const url = new URL(normalized);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return 'proxy';
  }
}

export function normalizeProxyUrl(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;

  const parts = raw.split(':');
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    const [host, port, username, ...passwordParts] = parts;
    const password = passwordParts.join(':');
    return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    const [host, port] = parts;
    return `http://${host}:${port}`;
  }

  throw new TypeError('Invalid proxy format. Use http://user:pass@host:port or host:port:user:pass.');
}
