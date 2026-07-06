// Первый безопасный запуск для реального кошелька: логин -> создать/загрузить игрока -> дамп состояния.
// Ничего не тратит. Показывает точную схему player/load, чтобы финализировать авто-цикл.
//
//   $env:ZENKO_MASTER_KEY="..."; node scripts/bootstrap.js main
//   $env:ZENKO_MASTER_KEY="..."; node scripts/bootstrap.js spare --username=myname
import { requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';
import { proxyLabel, proxyUrlForAccount } from '../src/accounts.js';
import { ensurePlayer } from '../src/player-bootstrap.js';

const account = process.argv[2];
if (!account) { console.error('Usage: node scripts/bootstrap.js <account> [--username=NAME]'); process.exit(1); }
const usernameArg = (process.argv.find(a => a.startsWith('--username=')) || '').split('=')[1];

const masterKey = requireMasterKey();
const wallet = loadWallet(account, masterKey);
const proxyUrl = proxyUrlForAccount(account);
const client = new ZenkoClient(wallet, { proxyUrl });

console.log(`[${account}] wallet ${wallet.address} via ${proxyLabel(proxyUrl)}`);

const login = await client.login();
console.log(`[${account}] login OK — token ${login.token.slice(0, 10)}… expires ${new Date(login.expiresAt).toISOString()}`);

// price/holdings context
try {
  const { zolanaPriceUsd } = await client.api('/api/price');
  console.log(`[${account}] ZOLANA price $${zolanaPriceUsd}`);
} catch {}

const username = usernameArg || account;
const state = await ensurePlayer(client, username, { log: (message) => console.log(`[${account}] ${message}`) });

// dump the schema so we can finalize the loop
console.log(`\n=== [${account}] player/load keys ===`);
console.log(Object.keys(state));
for (const k of Object.keys(state)) {
  const v = state[k];
  if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]`, v[0] ? JSON.stringify(v[0]).slice(0, 220) : '(empty)');
  else if (v && typeof v === 'object') console.log(`  ${k}: object`, JSON.stringify(v).slice(0, 180));
  else console.log(`  ${k}:`, v);
}
console.log('\n(full state saved to nothing — read above; no funds were spent)');
await client.logout();
