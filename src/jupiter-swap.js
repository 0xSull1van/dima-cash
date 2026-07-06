import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { DEFAULT_SOLANA_RPC, ZOLANA_MINT } from './stamina.js';

export const JUPITER_API_BASE = 'https://api.jup.ag';
export const JUPITER_SWAP_API = `${JUPITER_API_BASE}/swap/v1`;
export const JUPITER_PRICE_API = `${JUPITER_API_BASE}/price/v3`;
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEFAULT_SWAP_USD = 2;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const DEFAULT_SOL_RESERVE = 0.007;
const LAMPORTS_PER_SOL = 1_000_000_000n;

export function lamportsForUsd(usdAmount, solUsdPrice) {
  const usd = Number(usdAmount);
  const price = Number(solUsdPrice);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('invalid USD amount');
  if (!Number.isFinite(price) || price <= 0) throw new Error('invalid SOL/USD price');
  return BigInt(Math.ceil((usd / price) * Number(LAMPORTS_PER_SOL)));
}

export function solToLamports(solAmount) {
  const sol = Number(solAmount);
  if (!Number.isFinite(sol) || sol <= 0) throw new Error('invalid SOL amount');
  return BigInt(Math.ceil(sol * Number(LAMPORTS_PER_SOL)));
}

export function buildQuoteUrl({
  baseUrl = JUPITER_SWAP_API,
  inputMint = WSOL_MINT,
  outputMint = ZOLANA_MINT,
  amount,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
}) {
  const url = new URL(`${baseUrl}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('swapMode', 'ExactIn');
  url.searchParams.set('restrictIntermediateTokens', 'true');
  return url;
}

export function buildSwapRequestBody({
  quoteResponse,
  userPublicKey,
  priorityMaxLamports = 500000,
  priorityLevel = 'high',
}) {
  return {
    quoteResponse,
    userPublicKey,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: priorityMaxLamports,
        priorityLevel,
      },
    },
  };
}

export function assertSpendIsSafe({ balanceLamports, spendLamports, reserveLamports }) {
  const balance = BigInt(balanceLamports);
  const spend = BigInt(spendLamports);
  const reserve = BigInt(reserveLamports);
  if (balance < spend + reserve) {
    throw new Error(`insufficient SOL: balance ${balance} lamports < spend ${spend} + reserve ${reserve}`);
  }
}

export function capSpendToBalance({ requestedLamports, maxSpendLamports }) {
  const requested = BigInt(requestedLamports);
  if (requested <= 0n) throw new Error('invalid requested swap amount');
  if (maxSpendLamports === undefined || maxSpendLamports === null) {
    return { amountLamports: requested, cappedByBalance: false };
  }
  const maxSpend = BigInt(maxSpendLamports);
  if (maxSpend <= 0n) throw new Error(`insufficient SOL after reserve: max spend ${maxSpend} lamports`);
  if (requested <= maxSpend) return { amountLamports: requested, cappedByBalance: false };
  return { amountLamports: maxSpend, cappedByBalance: true };
}

function headers(apiKey, extra = {}) {
  if (!apiKey) throw new Error('JUPITER_API_KEY is required for Jupiter Price/Swap API');
  return { ...extra, 'x-api-key': apiKey };
}

async function fetchJson(url, { apiKey, fetchImpl = fetch, method = 'GET', body } = {}) {
  const init = {
    method,
    headers: headers(apiKey, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

export async function fetchSolUsdPrice({ apiKey, fetchImpl = fetch, priceApi = JUPITER_PRICE_API } = {}) {
  const url = new URL(priceApi);
  url.searchParams.set('ids', WSOL_MINT);
  const json = await fetchJson(url, { apiKey, fetchImpl });
  const price = json?.[WSOL_MINT]?.usdPrice;
  if (!Number.isFinite(Number(price))) throw new Error('could not read SOL/USD price from Jupiter');
  return Number(price);
}

export async function quoteSolToZolana({
  amountLamports,
  apiKey,
  fetchImpl = fetch,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  swapApi = JUPITER_SWAP_API,
} = {}) {
  const url = buildQuoteUrl({
    baseUrl: swapApi,
    inputMint: WSOL_MINT,
    outputMint: ZOLANA_MINT,
    amount: amountLamports,
    slippageBps,
  });
  return fetchJson(url, { apiKey, fetchImpl });
}

export async function buildSwapTransaction({
  quoteResponse,
  userPublicKey,
  apiKey,
  fetchImpl = fetch,
  swapApi = JUPITER_SWAP_API,
} = {}) {
  const body = buildSwapRequestBody({ quoteResponse, userPublicKey });
  const json = await fetchJson(`${swapApi}/swap`, {
    apiKey,
    fetchImpl,
    method: 'POST',
    body,
  });
  if (!json?.swapTransaction) throw new Error('Jupiter did not return swapTransaction');
  return json;
}

function keypairFromWallet(wallet) {
  if (!wallet?.secretKey) throw new Error('wallet secret key required to sign swap');
  return Keypair.fromSecretKey(wallet.secretKey instanceof Uint8Array ? wallet.secretKey : new Uint8Array(wallet.secretKey));
}

export async function signAndSendSwap({
  wallet,
  swapTransaction,
  rpcUrl = DEFAULT_SOLANA_RPC,
  commitment = 'confirmed',
  fetchImpl = null,
} = {}) {
  const payer = keypairFromWallet(wallet);
  const connection = new Connection(rpcUrl, fetchImpl ? { commitment, fetch: fetchImpl } : commitment);
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([payer]);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: commitment,
  });
  const blockhash = await connection.getLatestBlockhash(commitment);
  await connection.confirmTransaction({ signature, ...blockhash }, commitment);
  return signature;
}

export async function planStaminaFloatSwap({
  walletAddress,
  apiKey,
  fetchImpl = fetch,
  usdAmount = DEFAULT_SWAP_USD,
  solAmount = null,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  maxSpendLamports = null,
} = {}) {
  const solUsdPrice = solAmount == null ? await fetchSolUsdPrice({ apiKey, fetchImpl }) : null;
  const requestedAmountLamports = solAmount == null ? lamportsForUsd(usdAmount, solUsdPrice) : solToLamports(solAmount);
  const { amountLamports, cappedByBalance } = capSpendToBalance({
    requestedLamports: requestedAmountLamports,
    maxSpendLamports,
  });
  const quote = await quoteSolToZolana({ amountLamports, apiKey, fetchImpl, slippageBps });
  return {
    walletAddress,
    inputMint: WSOL_MINT,
    outputMint: ZOLANA_MINT,
    usdAmount: solAmount == null ? Number(usdAmount) : null,
    solUsdPrice,
    requestedAmountLamports,
    amountLamports,
    cappedByBalance,
    quote,
  };
}
