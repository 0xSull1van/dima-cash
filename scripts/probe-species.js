// READ-ONLY diagnostic for the species-aware floor parser (2026-07-06).
// Confirms the live market carries a `species` field and shows, for every traded species, its market
// metrics (floor / clearing median / sale count) and the exact IDEAL PRICE the bot would list at.
// GET reads only — never lists, buys, quotes, or signs anything.
//   node scripts/probe-species.js [AccountName]   (default Zephyr)
import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';
import { accountConfigsFromArgs } from '../src/accounts.js';
import { farmTradingConfig, fleetWalletAddresses } from '../src/startup-profile.js';
import {
  parseSales, parseListings, marketSpeciesOf,
  creatureMetricsBySpecies, creatureAsksBySpecies, creatureIdealPriceUsd,
  creatureClearingUsdByRarity, creatureAsksByRarity, creatureFloorZolanaByRarity,
} from '../src/marketplace.js';

loadEnv();
const masterKey = requireMasterKey();
const name = process.argv[2] || 'Zephyr';
const [account] = accountConfigsFromArgs([name]);
const wallet = loadWallet(name, masterKey);
const client = new ZenkoClient(wallet, { proxyUrl: account.proxyUrl });
await client.login();
console.log(`probing species market metrics as ${name} (${wallet.address})`);

const fleet = fleetWalletAddresses();
const cfg = farmTradingConfig();
const priceUsd = (await client.api('/api/price').catch(() => ({}))).zolanaPriceUsd ?? null;
const salesRaw = await client.api('/api/market/recent-sales?kind=creature&limit=200');
const rawSales = Array.isArray(salesRaw?.sales) ? salesRaw.sales : Array.isArray(salesRaw) ? salesRaw : [];
const browseRaw = await client.api('/api/market/browse?kind=creature');

// 1) confirm the species field parses on live data
console.log('\n=== species field confirmation ===');
if (rawSales[0]) {
  console.log('raw sale keys :', Object.keys(rawSales[0]).join(', '));
  if (rawSales[0].item && typeof rawSales[0].item === 'object') console.log('raw sale.item :', Object.keys(rawSales[0].item).join(', '));
  console.log('marketSpeciesOf(first) =>', JSON.stringify(marketSpeciesOf(rawSales[0])) || '(empty)');
}
const sales = parseSales(salesRaw);
const withSpecies = sales.filter((s) => s.species).length;
const pct = sales.length ? Math.round((withSpecies / sales.length) * 100) : 0;
console.log(`parsed ${sales.length} sales, ${withSpecies} carry a species (${pct}%)`);
if (sales.length && !withSpecies) {
  console.log('\n⚠️  NO species parsed — the live field name differs from the paths in marketSpeciesOf().');
  console.log('    Look at the raw keys above and add the correct path in src/marketplace.js (one line).');
  console.log('    Until then the bot prices per-rarity (its previous, still-correct behavior).');
}

// 2) per-species metrics + the ideal price the parser would use
const metrics = creatureMetricsBySpecies(sales, { fleetWallets: fleet });
const asks = creatureAsksBySpecies(parseListings(browseRaw), { fleetWallets: fleet });
const clearingByRar = creatureClearingUsdByRarity(sales, { fleetWallets: fleet });
const asksByRar = creatureAsksByRarity(parseListings(browseRaw), { fleetWallets: fleet });
const floorByRar = creatureFloorZolanaByRarity(sales, { zolanaPriceUsd: priceUsd, fleetWallets: fleet });

const species = Object.keys(metrics).sort((a, b) => metrics[b].count - metrics[a].count);
console.log(`\n=== per-species metrics + ideal price (${species.length} species traded, zolPrice $${priceUsd ?? '?'}) ===`);
console.log('species          rarity     sales  floor$    clearing$  ideal$    via');
for (const sp of species) {
  const m = metrics[sp];
  const ideal = creatureIdealPriceUsd({
    species: sp, rarity: m.rarity, variant: 'normal',
    metricsBySpecies: metrics, asksBySpecies: asks,
    clearingUsdByRarity: clearingByRar, asksByRarity: asksByRar,
    floorZolanaByRarity: floorByRar, zolanaPriceUsd: priceUsd, cfg, rng: () => 0.5,
  });
  console.log(
    `${sp.padEnd(16)} ${String(m.rarity || '?').padEnd(9)} ${String(m.count).padStart(5)}  ${m.floorUsd.toFixed(4)}  ${m.clearingUsd.toFixed(4)}   ${(ideal?.priceUsd ?? 0).toFixed(4)}   ${ideal?.source ?? 'none'}`,
  );
}
if (!species.length) console.log('(no creature species traded in the recent-sales window)');
await client.logout();
