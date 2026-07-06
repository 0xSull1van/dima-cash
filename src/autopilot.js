import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isZolanaGateError } from './player-bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_AUTOPILOT_LOG_DIR = join(__dirname, '..', 'logs');

export function classifyBootFailure(error, { executeFunding = false } = {}) {
  if (!isZolanaGateError(error)) return 'failed';
  return executeFunding ? 'fund' : 'dry-run';
}

export function hasLiveSnapshot(name, { logDir = DEFAULT_AUTOPILOT_LOG_DIR } = {}) {
  return existsSync(join(logDir, `live-${name}.json`));
}

export function selectAutopilotAccountNames(fundOpts = {}, {
  registryNames = [],
  hasLiveSnapshot: liveCheck = hasLiveSnapshot,
} = {}) {
  const names = Array.isArray(fundOpts.names) ? fundOpts.names.filter(Boolean) : [];
  if (fundOpts.all) return { selectedNames: registryNames.slice(), skippedNames: [] };
  if (names.length) return { selectedNames: names, skippedNames: [] };
  if (!fundOpts.working) return { selectedNames: names, skippedNames: [] };

  const selectedNames = [];
  const skippedNames = [];
  for (const name of registryNames) {
    if (liveCheck(name)) selectedNames.push(name);
    else skippedNames.push(name);
  }
  return { selectedNames, skippedNames };
}
