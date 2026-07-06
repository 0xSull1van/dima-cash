// Ban / health check: log in to each registered account and load player state, report status.
// Read-only (auth + player/load only, no actions). A ban shows as a login/load failure,
// 403, or a suspend/ban message.  node scripts/check-bans.js [--all]
import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';
import { accountConfigsFromArgs } from '../src/accounts.js';
import { registryAccountNames } from '../src/account-creator.js';

loadEnv();
const masterKey = requireMasterKey();
const onlyPlayers = !process.argv.includes('--all');
const names = registryAccountNames();
const accounts = accountConfigsFromArgs(names);

const BAN_RE = /ban|suspend|blocked|forbidden|cheat|abuse/i;

async function check(account) {
  const out = { name: account.name, status: 'OK', detail: '' };
  const wallet = loadWallet(account.name, masterKey);
  const client = new ZenkoClient(wallet, { proxyUrl: account.proxyUrl });
  try {
    await client.login();
  } catch (e) {
    out.status = (e.status === 403 || BAN_RE.test(e.bodyText || e.message || '')) ? 'BANNED?' : 'LOGIN-ERR';
    out.detail = `login ${e.status || ''} ${(e.bodyText || e.message || '').slice(0, 70)}`;
    return out;
  }
  try {
    const p = await client.api('/api/player/load');
    const pl = p.player || {};
    out.detail = `lvl ${pl.level ?? '?'} gold ${pl.gold ?? '?'} zolana ${pl.zenko_balance ?? '?'}`;
  } catch (e) {
    out.status = (e.status === 403 || BAN_RE.test(e.bodyText || e.message || '')) ? 'BANNED?' : 'LOAD-ERR';
    out.detail = `load ${e.status || ''} ${(e.bodyText || e.message || '').slice(0, 70)}`;
  }
  return out;
}

const results = [];
for (let i = 0; i < accounts.length; i += 5) {
  results.push(...await Promise.all(accounts.slice(i, i + 5).map(check)));
}

console.log('acct         status     detail');
console.log('-------------------------------------------------------------------');
const bad = [];
for (const r of results) {
  if (r.status !== 'OK') bad.push(r);
  console.log(r.name.padEnd(12), r.status.padEnd(10), r.detail);
}
console.log('-------------------------------------------------------------------');
console.log(`${results.length} checked · ${results.filter(r => r.status === 'OK').length} OK · ${bad.length} problem`);
if (bad.length) console.log('PROBLEM accounts:', bad.map(b => `${b.name}(${b.status})`).join(', '));
