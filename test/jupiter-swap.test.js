import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JUPITER_SWAP_API,
  WSOL_MINT,
  lamportsForUsd,
  buildQuoteUrl,
  buildSwapRequestBody,
  DEFAULT_SOL_RESERVE,
  assertSpendIsSafe,
  planStaminaFloatSwap,
  solToLamports,
} from '../src/jupiter-swap.js';
import { ZOLANA_MINT } from '../src/stamina.js';

test('converts a small USD float into SOL lamports', () => {
  assert.equal(lamportsForUsd(2, 200).toString(), '10000000');
  assert.equal(lamportsForUsd('2.50', '125').toString(), '20000000');
});

test('builds Jupiter quote URL for SOL to ZOLANA', () => {
  const url = buildQuoteUrl({
    baseUrl: JUPITER_SWAP_API,
    inputMint: WSOL_MINT,
    outputMint: ZOLANA_MINT,
    amount: 10_000_000n,
    slippageBps: 100,
  });

  assert.equal(url.toString(), `${JUPITER_SWAP_API}/quote?inputMint=${WSOL_MINT}&outputMint=${ZOLANA_MINT}&amount=10000000&slippageBps=100&swapMode=ExactIn&restrictIntermediateTokens=true`);
});

test('builds guarded swap request body', () => {
  assert.deepEqual(buildSwapRequestBody({
    quoteResponse: { routePlan: [] },
    userPublicKey: 'Wallet111111111111111111111111111111111',
  }), {
    quoteResponse: { routePlan: [] },
    userPublicKey: 'Wallet111111111111111111111111111111111',
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 500000,
        priorityLevel: 'high',
      },
    },
  });
});

test('refuses to spend below SOL reserve', () => {
  assert.doesNotThrow(() => assertSpendIsSafe({
    balanceLamports: 80_000_000n,
    spendLamports: 20_000_000n,
    reserveLamports: 50_000_000n,
  }));
  assert.throws(() => assertSpendIsSafe({
    balanceLamports: 60_000_000n,
    spendLamports: 20_000_000n,
    reserveLamports: 50_000_000n,
  }), /insufficient SOL/i);
});

test('default SOL reserve keeps room for Jupiter setup rent and fees', () => {
  assert.equal(solToLamports(DEFAULT_SOL_RESERVE).toString(), '7000000');
});

test('caps requested swap amount to account safe spend limit before quoting', async () => {
  const quoteUrls = [];
  const fetchImpl = async (url) => {
    quoteUrls.push(String(url));
    return {
      ok: true,
      text: async () => JSON.stringify({ outAmount: '1', routePlan: [] }),
    };
  };

  const plan = await planStaminaFloatSwap({
    walletAddress: 'Wallet111111111111111111111111111111111',
    apiKey: 'key',
    fetchImpl,
    solAmount: 0.016,
    maxSpendLamports: 14_000_000n,
  });

  assert.equal(plan.requestedAmountLamports.toString(), '16000000');
  assert.equal(plan.amountLamports.toString(), '14000000');
  assert.equal(plan.cappedByBalance, true);
  assert.match(quoteUrls[0], /amount=14000000/);
});
