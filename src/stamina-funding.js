import { Connection, PublicKey } from '@solana/web3.js';
import { loadWallet } from './wallet.js';
import { DEFAULT_SOLANA_RPC } from './stamina.js';
import { ZOLANA_MINT } from './stamina.js';
import { proxyFetchFor } from './proxy-fetch.js';
import {
  DEFAULT_SOL_RESERVE,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_SWAP_USD,
  assertSpendIsSafe,
  buildSwapTransaction,
  planStaminaFloatSwap,
  signAndSendSwap,
  solToLamports,
} from './jupiter-swap.js';

export const DEFAULT_SWAP_DELAY_MIN_SEC = 20;
export const DEFAULT_SWAP_DELAY_MAX_SEC = 90;
export const DEFAULT_MIN_ZOLANA_BALANCE = 1;

function numberOption(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${name}: ${value}`);
  return parsed;
}

export function parseStaminaFundingArgs(argv, env = process.env) {
  const opts = {
    names: [],
    usdAmount: numberOption(env.ZENKO_SWAP_USD, DEFAULT_SWAP_USD, 'ZENKO_SWAP_USD'),
    solAmount: env.ZENKO_SWAP_SOL ? numberOption(env.ZENKO_SWAP_SOL, null, 'ZENKO_SWAP_SOL') : null,
    slippageBps: numberOption(env.ZENKO_SWAP_SLIPPAGE_BPS, DEFAULT_SLIPPAGE_BPS, 'ZENKO_SWAP_SLIPPAGE_BPS'),
    reserveSol: numberOption(env.ZENKO_SWAP_RESERVE_SOL, DEFAULT_SOL_RESERVE, 'ZENKO_SWAP_RESERVE_SOL'),
    minZolanaBalance: numberOption(env.ZENKO_MIN_ZOLANA_BALANCE, DEFAULT_MIN_ZOLANA_BALANCE, 'ZENKO_MIN_ZOLANA_BALANCE'),
    delayMinSec: numberOption(env.ZENKO_SWAP_DELAY_MIN_SEC, DEFAULT_SWAP_DELAY_MIN_SEC, 'ZENKO_SWAP_DELAY_MIN_SEC'),
    delayMaxSec: numberOption(env.ZENKO_SWAP_DELAY_MAX_SEC, DEFAULT_SWAP_DELAY_MAX_SEC, 'ZENKO_SWAP_DELAY_MAX_SEC'),
    execute: env.ZENKO_SWAP_EXECUTE === '1',
    all: false,
    working: false,
  };

  for (const arg of argv) {
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--working') opts.working = true;
    else if (arg.startsWith('--usd=')) opts.usdAmount = numberOption(arg.split('=')[1], opts.usdAmount, '--usd');
    else if (arg.startsWith('--sol=')) opts.solAmount = numberOption(arg.split('=')[1], opts.solAmount, '--sol');
    else if (arg.startsWith('--slippage-bps=')) opts.slippageBps = numberOption(arg.split('=')[1], opts.slippageBps, '--slippage-bps');
    else if (arg.startsWith('--reserve-sol=')) opts.reserveSol = numberOption(arg.split('=')[1], opts.reserveSol, '--reserve-sol');
    else if (arg.startsWith('--min-zolana=')) opts.minZolanaBalance = numberOption(arg.split('=')[1], opts.minZolanaBalance, '--min-zolana');
    else if (arg.startsWith('--delay-min-sec=')) opts.delayMinSec = numberOption(arg.split('=')[1], opts.delayMinSec, '--delay-min-sec');
    else if (arg.startsWith('--delay-max-sec=')) opts.delayMaxSec = numberOption(arg.split('=')[1], opts.delayMaxSec, '--delay-max-sec');
    else opts.names.push(arg);
  }

  if (opts.delayMaxSec < opts.delayMinSec) opts.delayMaxSec = opts.delayMinSec;
  return opts;
}

export function fundingDelayMs({ index, execute, minSec, maxSec, rng = Math.random }) {
  if (!execute || index <= 0) return 0;
  const min = Math.max(0, Number(minSec) || 0);
  const max = Math.max(min, Number(maxSec) || min);
  const roll = Math.max(0, Math.min(1, Number(rng())));
  return Math.round((min + ((max - min) * roll)) * 1000);
}

async function zolanaBalance(connection, walletAddress) {
  if (typeof connection.getParsedTokenAccountsByOwner !== 'function') return null;
  const owner = new PublicKey(walletAddress);
  const mint = new PublicKey(ZOLANA_MINT);
  const result = await connection.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed').catch(() => null);
  if (!result?.value?.length) return 0;
  return result.value.reduce((sum, item) => {
    const amount = item?.account?.data?.parsed?.info?.tokenAmount;
    const ui = amount?.uiAmount ?? Number(amount?.uiAmountString);
    return Number.isFinite(Number(ui)) ? sum + Number(ui) : sum;
  }, 0);
}

export async function fundStaminaAccount({
  account,
  masterKey,
  apiKey,
  rpcUrl = DEFAULT_SOLANA_RPC,
  usdAmount = DEFAULT_SWAP_USD,
  solAmount = null,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  reserveSol = DEFAULT_SOL_RESERVE,
  minZolanaBalance = DEFAULT_MIN_ZOLANA_BALANCE,
  execute = false,
  loadWalletFn = loadWallet,
  fetchFactory = proxyFetchFor,
  connectionFactory = (url, fetchImpl) => new Connection(url, { commitment: 'confirmed', fetch: fetchImpl }),
  planSwapFn = planStaminaFloatSwap,
  buildSwapFn = buildSwapTransaction,
  signSwapFn = signAndSendSwap,
} = {}) {
  if (!account?.name) throw new Error('account name required');
  if (!masterKey) throw new Error('master key required');
  if (!apiKey) throw new Error('JUPITER_API_KEY is required for Jupiter Price/Swap API');

  const wallet = loadWalletFn(account.name, masterKey);
  const fetchImpl = fetchFactory(account.proxyUrl);
  const connection = connectionFactory(rpcUrl, fetchImpl);
  const balanceLamports = BigInt(await connection.getBalance(new PublicKey(wallet.address), 'confirmed'));
  const reserveLamports = solToLamports(reserveSol);
  const existingZolana = await zolanaBalance(connection, wallet.address);
  if (existingZolana != null && existingZolana >= minZolanaBalance) {
    return {
      name: account.name,
      address: wallet.address,
      proxyUrl: account.proxyUrl || null,
      balanceLamports,
      reserveLamports,
      zolanaBalance: existingZolana,
      skipped: true,
      skipReason: 'already_funded',
      executed: false,
      signature: null,
      plan: null,
    };
  }
  const plan = await planSwapFn({
    walletAddress: wallet.address,
    apiKey,
    fetchImpl,
    usdAmount,
    solAmount,
    slippageBps,
    maxSpendLamports: balanceLamports - reserveLamports,
  });

  assertSpendIsSafe({
    balanceLamports,
    spendLamports: plan.amountLamports,
    reserveLamports,
  });

  const result = {
    name: account.name,
    address: wallet.address,
    proxyUrl: account.proxyUrl || null,
    balanceLamports,
    reserveLamports,
    plan,
    executed: false,
    signature: null,
  };

  if (!execute) return result;

  const swap = await buildSwapFn({
    quoteResponse: plan.quote,
    userPublicKey: wallet.address,
    apiKey,
    fetchImpl,
  });
  result.signature = await signSwapFn({
    wallet,
    swapTransaction: swap.swapTransaction,
    rpcUrl,
    fetchImpl,
  });
  result.executed = true;
  return result;
}
