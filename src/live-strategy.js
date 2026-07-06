import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_DIR = join(__dirname, '..', 'logs');

function validDepth(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : null;
}

export function readLiveStrategy(name, { logDir = DEFAULT_LOG_DIR } = {}) {
  if (!name) return {};
  const file = join(logDir, `live-${name}.json`);
  if (!existsSync(file)) return {};

  try {
    const live = JSON.parse(readFileSync(file, 'utf8'));
    const dungeon = live?.dungeon || {};
    const depth = validDepth(dungeon.depth);
    const depthCeiling = validDepth(dungeon.ceiling);
    const efficientDepth = dungeon.efficient == null ? null : validDepth(dungeon.efficient);
    if (depth == null || depthCeiling == null || (dungeon.efficient != null && efficientDepth == null)) return {};
    return {
      depth,
      depthCeiling,
      efficientDepth,
    };
  } catch {
    return {};
  }
}
