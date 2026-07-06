// Optional .env loader (no dependency). Only used if the user creates a .env themselves.
// The master key is a runtime secret — this bot NEVER writes it to disk.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const p = join(__dirname, '..', '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export function upsertEnvFile(path, values) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values).map(([key, value]) => [key, String(value)]));
  const next = lines.map(line => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });

  for (const [key, value] of pending) next.push(`${key}=${value}`);
  while (next.length && next[next.length - 1] === '') next.pop();
  writeFileSync(path, `${next.join('\n')}\n`);
}

export function requireMasterKey() {
  loadEnv();
  const k = process.env.ZENKO_MASTER_KEY;
  if (!k) {
    console.error(
      '\nZENKO_MASTER_KEY is not set.\n' +
      'Set it in YOUR shell for this session (it is never stored on disk by the bot):\n' +
      '  PowerShell:  $env:ZENKO_MASTER_KEY = "<your-master-key>"\n' +
      '  bash:        export ZENKO_MASTER_KEY="<your-master-key>"\n'
    );
    process.exit(1);
  }
  return k;
}
