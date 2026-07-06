// One-process supervisor:
// - starts accounts that are already playable;
// - queues accounts gated by "Hold at least 1 $ZOLANA";
// - funds queued accounts sequentially through Jupiter, then boots them into the live bot set.
import { join } from 'node:path';
import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';
import { ZenkoBot } from '../src/bot.js';
import { accountConfigsFromArgs, proxyLabel } from '../src/accounts.js';
import { registryAccountNames } from '../src/account-creator.js';
import { createAccountJitterProfile } from '../src/jitter.js';
import { ensurePlayer } from '../src/player-bootstrap.js';
import { DEFAULT_SOLANA_RPC } from '../src/stamina.js';
import { classifyBootFailure, selectAutopilotAccountNames, DEFAULT_AUTOPILOT_LOG_DIR } from '../src/autopilot.js';
import { fundStaminaAccount, fundingDelayMs, parseStaminaFundingArgs } from '../src/stamina-funding.js';
import { updateRuntimeStatus } from '../src/runtime-status.js';
import { readLiveStrategy } from '../src/live-strategy.js';
import { buildBotConfig } from '../src/startup-profile.js';

loadEnv();

const args = process.argv.slice(2);
const fundOpts = parseStaminaFundingArgs(args, process.env);
const selected = selectAutopilotAccountNames(fundOpts, { registryNames: registryAccountNames() });
const accounts = accountConfigsFromArgs(selected.selectedNames);
const masterKey = requireMasterKey();
const runSeed = process.env.ZENKO_RUN_SEED || `${Date.now()}-${process.pid}`;
const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
const postFundDelaySec = Number(process.env.ZENKO_POST_FUND_BOOT_DELAY_SEC || 15);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

if (!accounts.length) {
  console.error('Usage: node scripts/run-autopilot.js --working | --all | <Account...> [--usd=1.3 --execute]');
  if (fundOpts.working) {
    console.error('       --working found no live accounts in logs/live-*.json. Run --all once only if you intentionally want bootstrap/funding.');
  }
  process.exit(1);
}

if (selected.skippedNames.length) {
  console.log(`[auto] --working: skipped ${selected.skippedNames.length} account(s) without live snapshot: ${selected.skippedNames.join(', ')}`);
  for (const name of selected.skippedNames) {
    updateRuntimeStatus(name, { status: 'skipped', detail: 'no live snapshot; not started in --working mode' });
  }
}

function botConfig(name, jitter) {
  return buildBotConfig({
    name,
    jitter,
    strategy: readLiveStrategy(name),
  });
}

async function bootAccount(account, index, { skipDelay = false } = {}) {
  const { name, proxyUrl } = account;
  const jitter = createAccountJitterProfile(name, { index, runSeed });
  updateRuntimeStatus(name, { status: 'booting', detail: proxyLabel(proxyUrl) });
  if (!skipDelay && jitter.bootDelayMs > 0) {
    console.log(`[auto] ${name} waiting ${(jitter.bootDelayMs / 1000).toFixed(1)}s before login`);
    await sleep(jitter.bootDelayMs);
  }

  const wallet = loadWallet(name, masterKey);
  // sessionPath (2026-07-06): persisting {token,expiresAt} to disk survives a process restart (including
  // the `node --watch` auto-restart on every code edit) — a real /api/auth/login happens only when the
  // token has truly expired (~every 8h, like a real player), not on every restart.
  const client = new ZenkoClient(wallet, { proxyUrl, sessionPath: join(DEFAULT_AUTOPILOT_LOG_DIR, `session-${name}.json`) });
  const resumed = Boolean(client.token); // restored from sessionPath BEFORE ensureAuth — we know whether a real login happened
  await client.ensureAuth();
  await ensurePlayer(client, name, { log: (message) => console.log(`[auto] ${name} ${message}`) });
  console.log(`[auto] ${name} ${wallet.address} ${resumed ? 'session restored (no re-login)' : 'online'} via ${proxyLabel(proxyUrl)}`);
  return new ZenkoBot(client, botConfig(name, jitter));
}

function startBot(account, bot, runners) {
  updateRuntimeStatus(account.name, { status: 'running', detail: 'bot loop active' });
  runners.push(bot.runForever().catch((error) => {
    updateRuntimeStatus(account.name, { status: 'failed', detail: String(error.message || error).slice(0, 180) });
    console.error(`[auto] ${account.name} bot loop failed: ${error.message || error}`);
  }));
}

async function main() {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey && fundOpts.execute) throw new Error('JUPITER_API_KEY is required for autopilot funding.');

  const queued = [];
  const runners = [];
  await Promise.all(accounts.map(async (account, index) => {
    try {
      const bot = await bootAccount(account, index);
      startBot(account, bot, runners);
    } catch (error) {
      const action = classifyBootFailure(error, { executeFunding: fundOpts.execute });
      if (action === 'fund' || action === 'dry-run') {
        updateRuntimeStatus(account.name, { status: action === 'fund' ? 'queued' : 'dry-run', detail: 'needs ZOLANA gate funding' });
        queued.push({ account, index, action });
        console.log(`[auto] ${account.name} queued: needs ZOLANA gate funding`);
      } else {
        updateRuntimeStatus(account.name, { status: 'failed', detail: String(error.message || error).slice(0, 180) });
        console.error(`[auto] ${account.name} boot failed: ${error.message || error}`);
      }
    }
  }));

  let fundingIndex = 0;
  for (const item of queued) {
    const { account, index, action } = item;
    if (action === 'dry-run') {
      console.log(`[auto] ${account.name} not funded. Add --execute to let autopilot buy ZOLANA.`);
      continue;
    }

    const delayMs = fundingDelayMs({
      index: fundingIndex++,
      execute: true,
      minSec: fundOpts.delayMinSec,
      maxSec: fundOpts.delayMaxSec,
    });
    if (delayMs > 0) {
      console.log(`[auto] ${account.name} funding wait ${(delayMs / 1000).toFixed(1)}s`);
      await sleep(delayMs);
    }

    try {
      updateRuntimeStatus(account.name, { status: 'funding', detail: `Jupiter swap ~$${fundOpts.usdAmount}` });
      const result = await fundStaminaAccount({
        account,
        masterKey,
        apiKey,
        rpcUrl,
        usdAmount: fundOpts.usdAmount,
        solAmount: fundOpts.solAmount,
        slippageBps: fundOpts.slippageBps,
        reserveSol: fundOpts.reserveSol,
        minZolanaBalance: fundOpts.minZolanaBalance,
        execute: true,
      });
      if (result.skipped) {
        updateRuntimeStatus(account.name, { status: 'funded', detail: `already holds ${result.zolanaBalance} ZOLANA` });
        console.log(`[auto] ${account.name} already funded (${result.zolanaBalance} ZOLANA)`);
        const bot = await bootAccount(account, index, { skipDelay: true });
        startBot(account, bot, runners);
        continue;
      }
      const solIn = Number(result.plan.amountLamports) / 1e9;
      updateRuntimeStatus(account.name, { status: 'funded', detail: `${solIn.toFixed(6)} SOL swapped` });
      console.log(`[auto] ${account.name} funded ${solIn.toFixed(6)} SOL tx=${result.signature}`);
      if (postFundDelaySec > 0) await sleep(postFundDelaySec * 1000);
      const bot = await bootAccount(account, index, { skipDelay: true });
      startBot(account, bot, runners);
    } catch (error) {
      updateRuntimeStatus(account.name, { status: 'failed', detail: String(error.message || error).slice(0, 180) });
      console.error(`[auto] ${account.name} funding/boot failed: ${error.message || error}`);
    }
  }

  if (!runners.length) {
    console.error('[auto] no bots are running.');
    process.exit(1);
  }
  await Promise.all(runners);
}

process.on('SIGINT', () => { console.log('\nstopping...'); process.exit(0); });

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
