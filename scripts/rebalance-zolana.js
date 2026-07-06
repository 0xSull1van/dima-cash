// Ребаланс $ZOLANA по флоту: у всех должно быть ≥10k (маркет-гейт), доливаем до ~12k из излишков
// богатых кошельков (донор не опускается ниже 13.5k). По умолчанию DRY-RUN (только план);
// --execute + ZENKO_MASTER_KEY — реальные переводы с человеческими паузами.
//   node scripts/rebalance-zolana.js                      # план по живым ончейн-балансам
//   node scripts/rebalance-zolana.js --execute            # выполнить план один раз
//   node scripts/rebalance-zolana.js --execute --watch-min=360   # проверять каждые ~6ч (±20%), вечно
import { loadEnv, requireMasterKey } from '../src/env.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { DEFAULT_SOLANA_RPC, ZOLANA_MINT } from '../src/stamina.js';
import { loadRegistry } from '../src/account-creator.js';
import { loadWallet } from '../src/wallet.js';
import { proxyFetchFor } from '../src/proxy-fetch.js';
import { fundingDelayMs } from '../src/stamina-funding.js';
import { appendLedgerEvent } from '../src/ledger.js';
import { planZolanaRebalance, sendZolana, REBALANCE_THRESHOLD, REBALANCE_TARGET } from '../src/zolana-rebalance.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { execute: false, watchMin: 0, threshold: REBALANCE_THRESHOLD, target: REBALANCE_TARGET };
  for (const a of argv) {
    if (a === '--execute') o.execute = true;
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
  // рабочие игроки: funded-статус ИЛИ уже играющие (main/spare живут вне статуса)
  const accounts = (loadRegistry().accounts || []).filter(a =>
    a.address && (a.status === 'stamina_float_ready' || ['main', 'spare'].includes(a.name)));
  console.log(`[rebalance] ончейн-балансы ${accounts.length} акков…`);
  const balances = [];
  for (const a of accounts) {
    const zolana = await onchainZolana(a.address, a.proxyUrl || process.env[a.proxyEnv], rpcUrl);
    balances.push({ name: a.name, address: a.address, proxyUrl: a.proxyUrl || process.env[a.proxyEnv] || null, zolana });
    console.log(`  ${a.name.padEnd(10)} ${Math.round(zolana)}`);
  }

  const plan = planZolanaRebalance(balances, { threshold: opts.threshold, target: opts.target });
  if (!plan.transfers.length) {
    console.log(`[rebalance] все ≥ ${opts.threshold} — переводы не нужны${plan.unmet.length ? ` (unmet: ${JSON.stringify(plan.unmet)})` : ''}`);
    return;
  }
  console.log('[rebalance] план:');
  for (const t of plan.transfers) console.log(`  ${t.from} → ${t.to}: ${t.amount} ZOLANA`);
  if (plan.unmet.length) console.log('[rebalance] ⚠️ доноров не хватило:', JSON.stringify(plan.unmet));
  if (!opts.execute) { console.log('[rebalance] dry-run — добавь --execute для реальных переводов'); return; }

  for (const [index, t] of plan.transfers.entries()) {
    const delayMs = fundingDelayMs({ index, execute: true, minSec: 25, maxSec: 110 });
    if (delayMs > 0) { console.log(`[rebalance] пауза ${(delayMs / 1000).toFixed(0)}s…`); await sleep(delayMs); }
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
      const waitMs = opts.watchMin * 60e3 * (0.8 + Math.random() * 0.4); // ±20% — не по часам
      console.log(`[rebalance] следующая проверка через ~${Math.round(waitMs / 60e3)} мин`);
      await sleep(waitMs);
    }
  } while (opts.watchMin > 0);
}

main().catch(e => { console.error('[rebalance] fatal:', e.message); process.exit(1); });
