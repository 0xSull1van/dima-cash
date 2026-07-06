// READ-ONLY live marketplace probe on ONE account.
// Issues only GET reads (ZenkoClient.api(path) with no body ⇒ GET). Never lists,
// buys, quotes, or signs anything. Answers: is there live demand for farmed Gold?
//   node scripts/probe-market.js [AccountName]   (default Zephyr)
import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';
import { accountConfigsFromArgs } from '../src/accounts.js';

loadEnv();
const masterKey = requireMasterKey();
const name = process.argv[2] || 'Zephyr';
const [account] = accountConfigsFromArgs([name]);
const wallet = loadWallet(name, masterKey);
const client = new ZenkoClient(wallet, { proxyUrl: account.proxyUrl });
await client.login();
console.log(`probing marketplace as ${name} (${wallet.address})\n`);

async function get(path) {
  try { return await client.api(path); } // no body ⇒ GET, structurally read-only
  catch (e) { return { __err: e.status || e.message }; }
}

function perUnit(row) {
  const usd = Number(row.price_usd ?? 0);
  const qty = Number(row.quantity ?? 1) || 1;
  return usd / qty;
}

for (const kind of ['gold', 'creature', 'relic']) {
  const browse = await get(`/api/market/browse?kind=${kind}`);
  const listings = Array.isArray(browse?.listings) ? browse.listings
    : Array.isArray(browse) ? browse : null;
  const sales = await get(`/api/market/recent-sales?kind=${kind}&limit=50`);
  const soldArr = Array.isArray(sales?.sales) ? sales.sales
    : Array.isArray(sales) ? sales : null;

  console.log(`── ${kind.toUpperCase()} ──`);
  if (!listings) { console.log('  browse:', JSON.stringify(browse).slice(0, 160)); }
  else {
    const zol = listings.filter(l => (l.currency ?? 'zolana') !== 'gems');
    console.log(`  live listings: ${listings.length} (${zol.length} $ZOLANA-lane)`);
    if (kind === 'gold' && zol.length) {
      const pu = zol.map(perUnit).filter(Number.isFinite).sort((a, b) => a - b);
      console.log(`  gold per-unit USD: floor ${pu[0]?.toFixed(8)} · median ${pu[Math.floor(pu.length/2)]?.toFixed(8)}`);
      console.log('  sample:', zol.slice(0, 3).map(l => ({ qty: l.quantity, usd: l.price_usd, cur: l.currency })));
    }
  }
  if (!soldArr) { console.log('  recent-sales:', JSON.stringify(sales).slice(0, 140)); }
  else {
    console.log(`  recent SALES (real demand): ${soldArr.length}`);
    if (soldArr.length) console.log('  newest sale:', JSON.stringify(soldArr[0]).slice(0, 180));
  }
  console.log('');
}
await client.logout();
