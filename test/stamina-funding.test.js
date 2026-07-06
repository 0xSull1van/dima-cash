import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fundStaminaAccount,
  fundingDelayMs,
  parseStaminaFundingArgs,
} from '../src/stamina-funding.js';

test('parses stamina funding defaults and explicit execution flags', () => {
  assert.deepEqual(parseStaminaFundingArgs(['--all'], {}), {
    names: [],
    usdAmount: 2,
    solAmount: null,
    slippageBps: 100,
    reserveSol: 0.007,
    minZolanaBalance: 1,
    delayMinSec: 20,
    delayMaxSec: 90,
    execute: false,
    all: true,
    working: false,
  });

  assert.deepEqual(parseStaminaFundingArgs([
    'Zephyr',
    '--execute',
    '--usd=1.5',
    '--sol=0.01',
    '--slippage-bps=150',
    '--reserve-sol=0.03',
    '--delay-min-sec=5',
    '--delay-max-sec=8',
  ], {}), {
    names: ['Zephyr'],
    usdAmount: 1.5,
    solAmount: 0.01,
    slippageBps: 150,
    reserveSol: 0.03,
    minZolanaBalance: 1,
    delayMinSec: 5,
    delayMaxSec: 8,
    execute: true,
    all: false,
    working: false,
  });
});

test('funding delay is sequential jitter only for executed non-first accounts', () => {
  assert.equal(fundingDelayMs({ index: 0, execute: true, minSec: 20, maxSec: 90, rng: () => 0.5 }), 0);
  assert.equal(fundingDelayMs({ index: 1, execute: false, minSec: 20, maxSec: 90, rng: () => 0.5 }), 0);
  assert.equal(fundingDelayMs({ index: 1, execute: true, minSec: 20, maxSec: 90, rng: () => 0 }), 20_000);
  assert.equal(fundingDelayMs({ index: 1, execute: true, minSec: 20, maxSec: 90, rng: () => 1 }), 90_000);
});

test('fundStaminaAccount caps low-balance accounts before quote and skips signing in dry-run', async () => {
  const wallet = { address: '8X1A3f8jBwXjaHnem9M97197m7DzoMYHkzu4V5B7Dmmq' };
  const calls = [];

  const result = await fundStaminaAccount({
    account: { name: 'Zephyr', proxyUrl: null },
    masterKey: 'master',
    apiKey: 'jup',
    rpcUrl: 'https://rpc.example',
    usdAmount: 1.3,
    solAmount: null,
    slippageBps: 100,
    reserveSol: 0.007,
    execute: false,
    loadWalletFn: () => wallet,
    fetchFactory: () => async () => ({}),
    connectionFactory: () => ({ getBalance: async () => 21_000_000 }),
    planSwapFn: async (opts) => {
      calls.push(opts);
      return {
        walletAddress: wallet.address,
        requestedAmountLamports: 16_000_000n,
        amountLamports: opts.maxSpendLamports,
        cappedByBalance: true,
        quote: { outAmount: '6000000000', routePlan: [{}] },
      };
    },
  });

  assert.equal(calls[0].maxSpendLamports.toString(), '14000000');
  assert.equal(result.executed, false);
  assert.equal(result.plan.amountLamports.toString(), '14000000');
  assert.equal(result.plan.cappedByBalance, true);
});

test('fundStaminaAccount skips accounts that already hold enough ZOLANA', async () => {
  let planned = false;
  const wallet = { address: '8X1A3f8jBwXjaHnem9M97197m7DzoMYHkzu4V5B7Dmmq' };

  const result = await fundStaminaAccount({
    account: { name: 'Zephyr', proxyUrl: null },
    masterKey: 'master',
    apiKey: 'jup',
    execute: true,
    loadWalletFn: () => wallet,
    fetchFactory: () => async () => ({}),
    connectionFactory: () => ({
      getBalance: async () => 21_000_000,
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: '2.5' } } } } } },
        ],
      }),
    }),
    planSwapFn: async () => {
      planned = true;
      throw new Error('should not quote');
    },
  });

  assert.equal(planned, false);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'already_funded');
  assert.equal(result.zolanaBalance, 2.5);
});
