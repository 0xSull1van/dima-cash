import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireMasterKey, upsertEnvFile } from '../src/env.js';
import { createAccounts } from '../src/account-creator.js';
import { loadProxyPool, normalizeProxyUrl, proxyEnvName, proxyLabel } from '../src/accounts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

function parseArgs(argv) {
  const opts = { names: [], targetSolMin: 0.05, targetSolMax: 0.08 };
  for (const arg of argv) {
    if (arg.startsWith('--min-sol=')) opts.targetSolMin = Number(arg.split('=')[1]);
    else if (arg.startsWith('--max-sol=')) opts.targetSolMax = Number(arg.split('=')[1]);
    else opts.names.push(arg);
  }
  if (!Number.isFinite(opts.targetSolMin) || opts.targetSolMin <= 0) throw new Error('invalid --min-sol');
  if (!Number.isFinite(opts.targetSolMax) || opts.targetSolMax < opts.targetSolMin) throw new Error('invalid --max-sol');
  return opts;
}

function printRows(title, rows) {
  if (!rows.length) return;
  console.log(`\n=== ${title} ===`);
  const widths = {
    name: Math.max(4, ...rows.map(row => row.name.length)),
    pubkey: Math.max(6, ...rows.map(row => String(row.pubkey || '').length)),
  };
  for (const row of rows) {
    console.log(`${row.name.padEnd(widths.name)}  ${String(row.pubkey || '-').padEnd(widths.pubkey)}  deposit ${row.deposit}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.names.length) {
    console.error('Usage: node scripts/create-accounts.js <nick1> <nick2> ... [--min-sol=0.05] [--max-sol=0.08]');
    process.exit(1);
  }

  const masterKey = requireMasterKey();
  const proxyPool = loadProxyPool();
  const proxyByName = Object.fromEntries(
    opts.names
      .map(name => [name, process.env[proxyEnvName(name)]])
      .filter(([, value]) => value)
      .map(([name, value]) => [name, normalizeProxyUrl(value)])
  );
  const result = createAccounts(opts.names, {
    masterKey,
    targetSolMin: opts.targetSolMin,
    targetSolMax: opts.targetSolMax,
    proxyByName,
    proxyPool,
  });
  const proxyEnvValues = Object.fromEntries(
    [...result.created, ...result.skipped]
      .filter(row => row.record.proxyEnv && row.record.proxyUrl)
      .map(row => [row.record.proxyEnv, row.record.proxyUrl])
  );
  if (Object.keys(proxyEnvValues).length) upsertEnvFile(ENV_PATH, proxyEnvValues);
  const deposit = `${opts.targetSolMin}-${opts.targetSolMax} SOL`;

  printRows('CREATED', result.created.map(row => ({
    name: row.name,
    pubkey: row.pubkey,
    deposit: `${deposit}  proxy ${row.record.proxyUrl ? proxyLabel(row.record.proxyUrl) : 'direct'}`,
  })));
  printRows('SKIPPED', result.skipped.map(row => ({
    name: row.name,
    pubkey: row.pubkey,
    deposit: row.reason,
  })));

  console.log(`\nRegistry: accounts.json`);
  console.log('Private keys were encrypted into wallets/*.enc.json and were not printed.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
