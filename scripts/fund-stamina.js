import { loadEnv, requireMasterKey } from '../src/env.js';
import { DEFAULT_SOLANA_RPC } from '../src/stamina.js';
import { loadRegistry, registryAccountNames, saveRegistry } from '../src/account-creator.js';
import { accountConfigsFromArgs, proxyLabel } from '../src/accounts.js';
import { fundStaminaAccount, fundingDelayMs, parseStaminaFundingArgs } from '../src/stamina-funding.js';

function updateRegistryStatus(name, patch) {
  const registry = loadRegistry();
  const account = registry.accounts.find(item => item.name === name);
  if (!account) return;
  Object.assign(account, patch);
  saveRegistry(registry);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  loadEnv();

  const opts = parseStaminaFundingArgs(process.argv.slice(2), process.env);
  const names = opts.all ? registryAccountNames() : opts.names;
  const accounts = accountConfigsFromArgs(names);
  if (!accounts.length) {
    console.error('Usage: node scripts/fund-stamina.js <account...> [--usd=2] [--execute]\n       node scripts/fund-stamina.js --all --usd=2 --execute --delay-min-sec=20 --delay-max-sec=90');
    process.exit(1);
  }

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) throw new Error('JUPITER_API_KEY is required. Create one in Jupiter Portal and set $env:JUPITER_API_KEY.');

  const masterKey = requireMasterKey();
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
  let failures = 0;

  for (const [index, account] of accounts.entries()) {
    const delayMs = fundingDelayMs({
      index,
      execute: opts.execute,
      minSec: opts.delayMinSec,
      maxSec: opts.delayMaxSec,
    });
    if (delayMs > 0) {
      console.log(`\n[fund] ${account.name} waiting ${(delayMs / 1000).toFixed(1)}s before swap`);
      await sleep(delayMs);
    }

    const { name, proxyUrl } = account;
    try {
      const result = await fundStaminaAccount({
        account,
        masterKey,
        apiKey,
        rpcUrl,
        usdAmount: opts.usdAmount,
        solAmount: opts.solAmount,
        slippageBps: opts.slippageBps,
        reserveSol: opts.reserveSol,
        minZolanaBalance: opts.minZolanaBalance,
        execute: opts.execute,
      });
      const { address, balanceLamports, reserveLamports, plan } = result;

      if (result.skipped) {
        console.log(`\n[${name}] ${address} via ${proxyLabel(proxyUrl)}`);
        console.log(`  balance ${(Number(balanceLamports) / 1e9).toFixed(4)} SOL`);
        console.log(`  skip: already holds ${result.zolanaBalance} ZOLANA`);
        continue;
      }

      const solIn = Number(plan.amountLamports) / 1e9;
      console.log(`\n[${name}] ${address} via ${proxyLabel(proxyUrl)}`);
      console.log(`  balance ${(Number(balanceLamports) / 1e9).toFixed(4)} SOL`);
      console.log(`  swap ${solIn.toFixed(6)} SOL -> expected ${plan.quote.outAmount} raw ZOLANA`);
      if (plan.cappedByBalance) {
        console.log(`  capped from ${(Number(plan.requestedAmountLamports) / 1e9).toFixed(6)} SOL to keep ${(Number(reserveLamports) / 1e9).toFixed(3)} SOL reserve`);
      }
      console.log(`  slippage ${opts.slippageBps} bps, route legs ${plan.quote.routePlan?.length || 0}`);

      if (!opts.execute) {
        console.log('  dry-run only. Add --execute to sign and send.');
        continue;
      }

      updateRegistryStatus(name, {
        status: 'stamina_float_ready',
        lastStaminaFloatAt: new Date().toISOString(),
        lastStaminaFloatSignature: result.signature,
        lastStaminaFloatSol: solIn,
      });
      console.log(`  sent ${result.signature}`);
    } catch (error) {
      failures += 1;
      console.error(`\n[${name}] funding failed: ${error.message || error}`);
    }
  }

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
