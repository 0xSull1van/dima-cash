import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNTIME_STATUS_PATH = join(__dirname, '..', 'logs', 'runtime-status.json');

const cleanName = (name) => String(name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');

export function runtimeStatusPath({ logDir = null } = {}) {
  return logDir ? join(logDir, 'runtime-status.json') : DEFAULT_RUNTIME_STATUS_PATH;
}

export function readRuntimeStatuses({ logDir = null, path = runtimeStatusPath({ logDir }) } = {}) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function updateRuntimeStatus(name, patch = {}, {
  logDir = null,
  path = runtimeStatusPath({ logDir }),
  now = () => Date.now(),
} = {}) {
  const safeName = cleanName(name);
  const statuses = readRuntimeStatuses({ path });
  statuses[safeName] = {
    ...(statuses[safeName] || { name: safeName }),
    ...patch,
    name: safeName,
    updatedAt: now(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(statuses, null, 2));
  return statuses[safeName];
}
