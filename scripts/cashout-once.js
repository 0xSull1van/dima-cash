// Controlled one-shot Gold cashout helper.
// Default mode is a read-only plan: no market listing is created unless command is "list".
// Cancel is also explicit and requires a listing id.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { accountConfigsFromArgs, proxyLabel } from '../src/accounts.js';
import { ZenkoClient } from '../src/client.js';
import { loadEnv, requireMasterKey } from '../src/env.js';
import {
  activeListingCount,
  cancelListing,
  getGoldFloorUsd,
  getMyGoldListings,
  listGold,
  planGoldListing,
} from '../src/marketplace.js';
import { loadWallet } from '../src/wallet.js';

export const CASHOUT_ONCE_DEFAULT_CFG = {
  cashoutGoldReserve: 50_000,
  cashoutMinLotGold: 50_000,
  cashoutMinPriceUsd: 0.05,
  cashoutChunkFracMin: 0.2,
  cashoutChunkFracMax: 0.5,
  cashoutPriceJitterMin: 1,
  cashoutPriceJitterMax: 1,
  cashoutMaxActiveListings: 3,
};

const COMMANDS = new Set(['plan', 'list', 'cancel']);

function parseFiniteNumber(raw, name) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function parseOption(token) {
  const match = token.match(/^--([^=]+)(?:=(.*))?$/);
  if (!match) return null;
  return { key: match[1], value: match[2] ?? 'true' };
}

export function parseCashoutOnceArgs(argv = []) {
  const cfg = { ...CASHOUT_ONCE_DEFAULT_CFG };
  const positionals = [];
  let help = false;

  for (const token of argv) {
    const opt = parseOption(token);
    if (!opt) {
      positionals.push(token);
      continue;
    }

    if (opt.key === 'help' || opt.key === 'h') {
      help = true;
    } else if (opt.key === 'reserve') {
      cfg.cashoutGoldReserve = parseFiniteNumber(opt.value, '--reserve');
    } else if (opt.key === 'min-lot') {
      cfg.cashoutMinLotGold = parseFiniteNumber(opt.value, '--min-lot');
    } else if (opt.key === 'min-price-usd') {
      cfg.cashoutMinPriceUsd = parseFiniteNumber(opt.value, '--min-price-usd');
    } else if (opt.key === 'max-active') {
      cfg.cashoutMaxActiveListings = parseFiniteNumber(opt.value, '--max-active');
    } else if (opt.key === 'chunk-frac-min') {
      cfg.cashoutChunkFracMin = parseFiniteNumber(opt.value, '--chunk-frac-min');
    } else if (opt.key === 'chunk-frac-max') {
      cfg.cashoutChunkFracMax = parseFiniteNumber(opt.value, '--chunk-frac-max');
    } else if (opt.key === 'price-jitter-min') {
      cfg.cashoutPriceJitterMin = parseFiniteNumber(opt.value, '--price-jitter-min');
    } else if (opt.key === 'price-jitter-max') {
      cfg.cashoutPriceJitterMax = parseFiniteNumber(opt.value, '--price-jitter-max');
    } else {
      throw new Error(`unknown option --${opt.key}`);
    }
  }

  let accountName = 'Zephyr';
  let command = 'plan';
  let listingId = null;

  if (positionals.length && COMMANDS.has(String(positionals[0]).toLowerCase())) {
    command = String(positionals.shift()).toLowerCase();
  } else if (positionals.length) {
    accountName = positionals.shift();
  }

  if (positionals.length && COMMANDS.has(String(positionals[0]).toLowerCase())) {
    command = String(positionals.shift()).toLowerCase();
  }

  if (command === 'cancel') {
    listingId = positionals.shift() || null;
    if (!listingId) throw new Error('cancel requires a listing id');
  }

  if (positionals.length) throw new Error(`unexpected argument: ${positionals[0]}`);

  return {
    accountName,
    command,
    cfg,
    help,
    listingId,
    write: command === 'list' || command === 'cancel',
  };
}

export function buildCashoutPlan({
  gold,
  floorUsd,
  myGoldListings = [],
  rng = Math.random,
  cfg = CASHOUT_ONCE_DEFAULT_CFG,
} = {}) {
  const activeGoldListings = activeListingCount(myGoldListings, { itemKind: 'gold', currency: 'zenko' });
  const maxActive = Math.max(0, Number(cfg.cashoutMaxActiveListings ?? CASHOUT_ONCE_DEFAULT_CFG.cashoutMaxActiveListings));
  const goldBalance = Number(gold) || 0;
  const reserve = Number(cfg.cashoutGoldReserve) || 0;
  const surplus = goldBalance - reserve;
  const base = {
    activeGoldListings,
    floorUsd,
    gold: goldBalance,
    maxActiveListings: maxActive,
    reserve,
    surplus,
  };

  if (activeGoldListings >= maxActive) {
    return { ...base, mode: 'skip', reason: 'max-active-listings' };
  }
  if (surplus < cfg.cashoutMinLotGold) {
    return { ...base, mode: 'skip', reason: 'surplus-below-min-lot' };
  }
  if (!(floorUsd > 0)) {
    return { ...base, mode: 'skip', reason: 'missing-gold-floor' };
  }

  const lot = planGoldListing({ surplus, floorUsd, rng, cfg });
  if (!lot) return { ...base, mode: 'skip', reason: 'planner-returned-null' };
  return { ...base, ...lot, currency: 'zenko', itemKind: 'gold', mode: 'list' };
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/cashout-once.js [Account] [plan]',
    '  node scripts/cashout-once.js [Account] list',
    '  node scripts/cashout-once.js [Account] cancel <listingId>',
    '',
    'Default command is plan: login + read market/player state, print the planned lot, create nothing.',
    'Write commands are explicit: list creates one Gold listing; cancel cancels one listing id.',
    '',
    'Options:',
    '  --reserve=50000',
    '  --min-lot=50000',
    '  --min-price-usd=0.05',
    '  --max-active=3',
    '  --chunk-frac-min=0.2',
    '  --chunk-frac-max=0.5',
    '  --price-jitter-min=1',
    '  --price-jitter-max=1',
  ].join('\n'));
}

function printPlan(args, plan, { walletAddress, proxy }) {
  console.log(JSON.stringify({
    account: args.accountName,
    address: walletAddress,
    command: args.command,
    dryRun: args.command === 'plan',
    proxy,
    plan,
  }, null, 2));
  if (args.command === 'plan') {
    console.log('\nDRY RUN: no market listing created. Re-run with "list" to create this planned Gold listing.');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCashoutOnceArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }

  loadEnv();
  const masterKey = requireMasterKey();
  const [account] = accountConfigsFromArgs([args.accountName]);
  const wallet = loadWallet(args.accountName, masterKey);
  const client = new ZenkoClient(wallet, { proxyUrl: account?.proxyUrl });

  try {
    await client.login();
    console.log(`[cashout-once] ${args.accountName} ${wallet.address} via ${proxyLabel(account?.proxyUrl)}`);

    if (args.command === 'cancel') {
      const result = await cancelListing(client, args.listingId);
      console.log(JSON.stringify({ command: 'cancel', listingId: args.listingId, result }, null, 2));
      return;
    }

    const [state, floorUsd, myGoldListings] = await Promise.all([
      client.api('/api/player/load'),
      getGoldFloorUsd(client),
      getMyGoldListings(client),
    ]);
    const plan = buildCashoutPlan({
      gold: state?.player?.gold,
      floorUsd,
      myGoldListings,
      cfg: args.cfg,
    });
    printPlan(args, plan, { walletAddress: wallet.address, proxy: proxyLabel(account?.proxyUrl) });

    if (args.command !== 'list') return;
    if (plan.mode !== 'list') throw new Error(`refusing to list: ${plan.reason}`);

    const result = await listGold(client, { quantity: plan.quantity, priceUsd: plan.priceUsd });
    console.log(JSON.stringify({
      command: 'list',
      listing: { itemKind: 'gold', quantity: plan.quantity, priceUsd: plan.priceUsd, currency: 'zenko' },
      result,
    }, null, 2));
  } finally {
    await client.logout();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
