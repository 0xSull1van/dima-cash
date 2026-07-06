// Read-only per-account analytics: holdings, gold/gems, gold accumulation rate, USD value.
// Buys nothing and sends nothing. Only login + player/load + price.
//   $env:ZENKO_MASTER_KEY="..."; node scripts/dashboard.js            # main + spare
//   $env:ZENKO_MASTER_KEY="..."; node scripts/dashboard.js main
import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';
import { accountConfigsFromArgs } from '../src/accounts.js';
import { analyzeAccountState } from '../src/account-analysis.js';
import { registryAccountNames } from '../src/account-creator.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, '..', 'logs');
mkdirSync(SNAP_DIR, { recursive: true });

loadEnv();

const args = process.argv.slice(2);
const accounts = accountConfigsFromArgs(args.includes('--all') ? registryAccountNames() : args);
const masterKey = requireMasterKey();

function loadSnap(name) {
  const p = join(SNAP_DIR, `dash-${name}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function saveSnap(name, snap) {
  writeFileSync(join(SNAP_DIR, `dash-${name}.json`), JSON.stringify(snap, null, 2));
}
const fmt = (n) => Number(n).toLocaleString('en-US');

let price = 0;
const rows = [];

for (const account of accounts) {
  const { name, proxyUrl } = account;
  const client = new ZenkoClient(loadWallet(name, masterKey), { proxyUrl });
  await client.login();
  if (!price) { try { price = (await client.api('/api/price')).zolanaPriceUsd; } catch {} }
  const s = await client.api('/api/player/load');
  const p = s.player || {};

  const now = Date.now();
  const prev = loadSnap(name);
  let goldPerHr = null;
  if (prev && prev.gold != null) {
    const dh = (now - prev.t) / 3.6e6;
    if (dh > 0.01) goldPerHr = Math.round((p.gold - prev.gold) / dh);
  }
  saveSnap(name, { t: now, gold: p.gold, gems: p.gems, zenko: p.zenko_balance });

  const placed = (s.creatures || []).filter(c => c.plot_x != null).length;
  const activeRuns = (s.dungeonRuns || []).filter(r => r.status !== 'claimed' && r.status !== 'done').length;
  const summary = analyzeAccountState(s, { name, address: client.address, priceUsd: price });

  rows.push({
    name,
    addr: client.address.slice(0, 4) + '…' + client.address.slice(-4),
    lvl: p.level,
    gold: p.gold,
    goldPerHr,
    gems: p.gems,
    stamina: `${p.stamina}/180`,
    creatures: (s.creatures || []).length,
    placed,
    eggs: (s.eggs || []).length,
    pendingEggs: (s.eggs || []).filter(e => e.status !== 'hatched').length,
    runs: activeRuns,
    mats: (s.materials || []).length,
    zenko: p.zenko_balance,
    usd: price ? p.zenko_balance * price : null,
    hero: summary.hero?.label || 'n/a',
    idleParties: summary.dungeon.fullParties,
    readyRuns: summary.dungeon.readyRuns,
    relics: summary.relics,
    topLoot: summary.loot.topMaterials.map(item => `${item.name}x${item.count}`).join(', ') || 'none',
    actions: summary.recommendations,
  });
  // no logout — so we don't kill the session of a bot running in parallel
}

console.log(`\n=== ZENKO DASHBOARD  (ZOLANA $${price ? price.toExponential(4) : '?'}) ===\n`);
for (const r of rows) {
  console.log(`[${r.name}] ${r.addr}  lvl ${r.lvl}`);
  console.log(`   gold ${fmt(r.gold)}${r.goldPerHr != null ? `  (${r.goldPerHr >= 0 ? '+' : ''}${fmt(r.goldPerHr)}/hr)` : '  (rate: run again later)'}   gems ${r.gems}   stamina ${r.stamina}`);
  console.log(`   creatures ${r.creatures} (placed ${r.placed})   eggs ${r.pendingEggs} pending / ${r.eggs} total   active dungeons ${r.runs}   mats ${r.mats}`);
  console.log(`   hero ${r.hero}   idle full parties ${r.idleParties}   ready claims ${r.readyRuns}`);
  console.log(`   relics ${r.relics.equipped}/${r.relics.total} equipped (${r.relics.freeCombat} free combat available)   loot ${r.topLoot}`);
  console.log(`   status ${r.actions.join(' | ')}`);
  console.log(`   $ZOLANA held ${fmt(r.zenko)}${r.usd != null ? `  ≈ $${r.usd.toFixed(2)}` : ''}`);
  console.log('');
}
const totalUsd = rows.reduce((s, r) => s + (r.usd || 0), 0);
console.log(`TOTAL $ZOLANA value ≈ $${totalUsd.toFixed(2)} across ${rows.length} account(s)`);
console.log('Note: this is holdings value, NOT realizable P&L — $ZOLANA liquidity is ~$2.8K,');
console.log('so meaningful sells would crater the price. Gold is in-game only (not withdrawable).');
