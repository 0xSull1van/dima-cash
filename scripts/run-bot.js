// Run one or many accounts in parallel.
//   node scripts/run-bot.js            # main + spare
//   node scripts/run-bot.js main       # only main
//   node scripts/run-bot.js --all      # every account in accounts.json (incl. player-less wallets)
//   node scripts/run-bot.js --players  # only WORKING accounts (have an in-game player) — skips
//                                      # player-less wallets (collectors, un-created accounts)
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';
import { ZenkoBot } from '../src/bot.js';
import { accountConfigsFromArgs, proxyLabel } from '../src/accounts.js';
import { registryAccountNames } from '../src/account-creator.js';
import { createAccountJitterProfile } from '../src/jitter.js';
import { ensurePlayer, isZolanaGateError } from '../src/player-bootstrap.js';
import { readLiveStrategy } from '../src/live-strategy.js';
import { buildBotConfig } from '../src/startup-profile.js';

loadEnv();

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
// "Working" = the bot has produced a live snapshot for it (i.e. it has an in-game player).
// Player-less wallets (never created / collectors) never get a live-*.json.
const hasPlayer = (name) => existsSync(join(LOG_DIR, `live-${name}.json`));

const masterKey = requireMasterKey();
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const namedArgs = args.filter(a => !a.startsWith('--'));

let selectedNames;
if (flags.includes('--players')) {
  selectedNames = registryAccountNames().filter(hasPlayer);
  if (!selectedNames.length) {
    console.error('[boot] --players: no working accounts found (no logs/live-*.json).');
    console.error('       Run `--all` once so players get created + snapshots written, then use --players.');
    process.exit(1);
  }
  console.log(`[boot] --players: ${selectedNames.length} working accounts → ${selectedNames.join(', ')}`);
} else if (flags.includes('--all')) {
  selectedNames = registryAccountNames();
} else {
  selectedNames = namedArgs;
}
const accounts = accountConfigsFromArgs(selectedNames);
const runSeed = process.env.ZENKO_RUN_SEED || `${Date.now()}-${process.pid}`;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function bootAccount(account, index) {
  const { name, proxyUrl } = account;
  const jitter = createAccountJitterProfile(name, { index, runSeed });
  if (jitter.bootDelayMs > 0) {
    console.log(`[boot] ${name} waiting ${(jitter.bootDelayMs / 1000).toFixed(1)}s before login`);
    await sleep(jitter.bootDelayMs);
  }

  const wallet = loadWallet(name, masterKey);
  // sessionPath (2026-07-06): persisting {token,expiresAt} to disk survives a process restart (including
  // the `node --watch` auto-restart on every code edit) — a real /api/auth/login happens only when the
  // token has truly expired (~every 8h, like a real player), not on every restart.
  const client = new ZenkoClient(wallet, { proxyUrl, sessionPath: join(LOG_DIR, `session-${name}.json`) });
  const resumed = Boolean(client.token); // restored from sessionPath BEFORE ensureAuth — we know whether a real login happened
  await client.ensureAuth();
  await ensurePlayer(client, name, { log: (message) => console.log(`[boot] ${name} ${message}`) });
  console.log(`[boot] ${name} ${wallet.address} ${resumed ? 'session restored (no re-login)' : 'logged in'} via ${proxyLabel(proxyUrl)} tick=${jitter.tickMinSec}-${jitter.tickMaxSec}s action=${jitter.actionDelayMinMs}-${jitter.actionDelayMaxMs}ms`);

  return new ZenkoBot(client, buildBotConfig({
    name,
    jitter,
    strategy: readLiveStrategy(name),
  }));
}

process.on('SIGINT', () => { console.log('\nstopping...'); process.exit(0); });

const bots = (await Promise.all(accounts.map(async (account, index) => {
  try {
    return await bootAccount(account, index);
  } catch (error) {
    if (isZolanaGateError(error)) {
      console.log(`[boot] ${account.name} skipped: needs at least 1 $ZOLANA. Run: node scripts/fund-stamina.js ${account.name} --usd=2 --execute`);
    } else {
      console.error(`[boot] ${account.name} failed: ${error.message || error}`);
    }
    return null;
  }
}))).filter(Boolean);

if (!bots.length) {
  console.error('[boot] no accounts are ready. Fund ZOLANA first, then rerun.');
  process.exit(1);
}

await Promise.all(bots.map(b => b.runForever()));
