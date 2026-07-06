// Rebalance $ZOLANA across the fleet: everyone should have ≥10k (the market gate), top up to ~12k from
// the surplus of rich wallets (a donor never drops below 13.5k). Only funds short accounts that actually
// have something to sell (sellable pets or a Gold pile) — no point opening a market for an empty account.
// DRY-RUN by default (plan only); --execute + ZENKO_MASTER_KEY — real transfers with human pauses.
//   node scripts/rebalance-zolana.js                      # plan from live on-chain balances
//   node scripts/rebalance-zolana.js --execute            # run the plan once
//   node scripts/rebalance-zolana.js --execute --watch-min=360   # check every ~6h (±20%), forever
//   node scripts/rebalance-zolana.js --no-gate            # fund every short account (ignore the "has something to sell" gate)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireMasterKey } from '../src/env.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { DEFAULT_SOLANA_RPC, ZOLANA_MINT } from '../src/stamina.js';
import { loadRegistry } from '../src/account-creator.js';
import { loadWallet } from '../src/wallet.js';
import { proxyFetchFor } from '../src/proxy-fetch.js';
import { fundingDelayMs } from '../src/stamina-funding.js';
import { appendLedgerEvent } from '../src/ledger.js';
import { pickJunkCreatures } from '../src/marketplace.js';
import { farmTradingConfig } from '../src/startup-profile.js';
import { planZolanaRebalance, sendZolana, REBALANCE_THRESHOLD, REBALANCE_TARGET } from '../src/zolana-rebalance.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');

// The "sellable" criteria kept in sync with what the farm actually lists (junk* keys from the farm
// profile), so the "makes sense to sell" gate counts exactly the pets the bot would put on the market.
const JUNK_CFG = (() => {
  const c = farmTradingConfig();
  return {
    junkCreatureRarities: c.junkCreatureRarities,
    junkCreatureStages: c.junkCreatureStages,
    junkCreatureVariants: c.junkCreatureVariants,
    junkVariantRarityOverrides: c.junkVariantRarityOverrides,
    junkCreatureKeepPerSpecies: c.junkCreatureKeepPerSpecies,
    junkMinBreedCount: c.junkMinBreedCount,
    junkSurplusKeepPerSpecies: c.junkSurplusKeepPerSpecies,
    junkProtectLux: c.junkProtectLux,
  };
})();

// Per-account sellable inventory from the live snapshots the farm writes (logs/live-*.json):
// { name -> { pets, gold } }. pets = how many the farm would list right now (pickJunkCreatures);
// gold = the account's Gold balance. Feeds the planner's "makes sense to sell" gate. Read-only.
export function readSellableInventory(logDir = LOG_DIR) {
  const out = {};
  if (!existsSync(logDir)) return out;
  for (const f of readdirSync(logDir)) {
    if (!/^live-.*\.json$/.test(f)) continue;
    let live; try { live = JSON.parse(readFileSync(join(logDir, f), 'utf8')); } catch { continue; }
    if (!live?.name) continue;
    const pets = pickJunkCreatures(live.creaturesList || [], JUNK_CFG).length;
    const gold = Number(live.player?.gold) || 0;
    out[live.name] = { pets, gold };
  }
  return out;
}

function parseArgs(argv) {
  const o = { execute: false, watchMin: 0, threshold: REBALANCE_THRESHOLD, target: REBALANCE_TARGET, gate: true };
  for (const a of argv) {
    if (a === '--execute') o.execute = true;
    else if (a === '--no-gate') o.gate = false; // fund every short account, even with nothing to sell
    else if (a.startsWith('--watch-min=')) o.watchMin = Number(a.split('=')[1]) || 0;
    else if (a.startsWith('--threshold=')) o.threshold = Number(a.split('=')[1]) || o.threshold;
    else if (a.startsWith('--target=')) o.target = Number(a.split('=')[1]) || o.target;
  }
  return o;
}

async function onchainZolana(address, proxyUrl, rpcUrl) {
  const fetchImpl = proxyFetchFor(proxyUrl);
  const connection = new Connection(rpcUrl, { commitment: 'confirmed', fetch: fetchImpl });
  const result = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(address), { mint: new PublicKey(ZOLANA_MINT) }, 'confirmed',
  ).catch(() => null);
  if (!result?.value?.length) return 0;
  return result.value.reduce((sum, item) => {
    const ui = item?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    return Number.isFinite(Number(ui)) ? sum + Number(ui) : sum;
  }, 0);
}

async function passOnce(opts, rpcUrl, masterKey) {
  // working players: funded status OR already playing (main/spare live outside the status)
  const accounts = (loadRegistry().accounts || []).filter(a =>
    a.address && (a.status === 'stamina_float_ready' || ['main', 'spare'].includes(a.name)));
  console.log(`[rebalance] on-chain balances of ${accounts.length} accounts…`);
  const balances = [];
  for (const a of accounts) {
    const zolana = await onchainZolana(a.address, a.proxyUrl || process.env[a.proxyEnv], rpcUrl);
    balances.push({ name: a.name, address: a.address, proxyUrl: a.proxyUrl || process.env[a.proxyEnv] || null, zolana });
    console.log(`  ${a.name.padEnd(10)} ${Math.round(zolana)}`);
  }

  const inventory = readSellableInventory(LOG_DIR);
  const plan = planZolanaRebalance(balances, {
    threshold: opts.threshold,
    target: opts.target,
    sellableByName: opts.gate ? inventory : null, // gate on "has something to sell" unless --no-gate
  });
  if (plan.skipped?.length) {
    console.log(`[rebalance] skipped ${plan.skipped.length} short acct(s) with nothing to sell: ${plan.skipped.map(s => s.name).join(', ')}`);
  }
  if (!plan.transfers.length) {
    const waiting = plan.recipients?.length ? ` — ${plan.recipients.length} acct(s) under the gate wait for a donor: ${plan.recipients.join(', ')}` : '';
    console.log(`[rebalance] no transfers${plan.donors.length ? '' : ' (no donor above the floor yet)'}${waiting}${plan.unmet.length ? ` (unmet: ${JSON.stringify(plan.unmet)})` : ''}`);
    return;
  }
  console.log('[rebalance] plan:');
  for (const t of plan.transfers) console.log(`  ${t.from} → ${t.to}: ${t.amount} ZOLANA`);
  if (plan.unmet.length) console.log('[rebalance] ⚠️ not enough donors:', JSON.stringify(plan.unmet));
  if (!opts.execute) { console.log('[rebalance] dry-run — add --execute for real transfers'); return; }

  for (const [index, t] of plan.transfers.entries()) {
    const delayMs = fundingDelayMs({ index, execute: true, minSec: 25, maxSec: 110 });
    if (delayMs > 0) { console.log(`[rebalance] pause ${(delayMs / 1000).toFixed(0)}s…`); await sleep(delayMs); }
    try {
      const wallet = loadWallet(t.from, masterKey);
      const sig = await sendZolana(wallet, { toAddress: t.toAddress, amountZolana: t.amount, rpcUrl });
      console.log(`[rebalance] ✔ ${t.from} → ${t.to}: ${t.amount} ZOLANA tx=${sig.slice(0, 12)}…`);
      appendLedgerEvent(t.from, { type: 'zolana_rebalance', amounts: { zolana: -t.amount }, tx: sig, ref: { peer: t.to, direction: 'out' } });
      appendLedgerEvent(t.to, { type: 'zolana_rebalance', amounts: { zolana: t.amount }, tx: sig, ref: { peer: t.from, direction: 'in' } });
    } catch (e) {
      console.error(`[rebalance] ✖ ${t.from} → ${t.to}: ${e.message}`);
    }
  }
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
  const masterKey = opts.execute ? requireMasterKey() : null;

  do {
    await passOnce(opts, rpcUrl, masterKey);
    if (opts.watchMin > 0) {
      const waitMs = opts.watchMin * 60e3 * (0.8 + Math.random() * 0.4); // ±20% — not on the hour
      console.log(`[rebalance] next check in ~${Math.round(waitMs / 60e3)} min`);
      await sleep(waitMs);
    }
  } while (opts.watchMin > 0);
}

main().catch(e => { console.error('[rebalance] fatal:', e.message); process.exit(1); });
