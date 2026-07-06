import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { accountConfigsFromArgs, proxyLabel } from '../src/accounts.js';
import { ZenkoClient } from '../src/client.js';
import { loadEnv, requireMasterKey } from '../src/env.js';
import {
  activeListingCount,
  cancelListing,
  getGoldFloorUsd,
  getMyListings,
  getMySales,
  listGold,
  planGoldListing,
} from '../src/marketplace.js';
import { loadWallet } from '../src/wallet.js';

export const MARKET_SMOKE_DEFAULT_CFG = {
  cashoutGoldReserve: 0,
  cashoutMinLotGold: 50_000,
  cashoutMinPriceUsd: 0.05,
  cashoutChunkFracMin: 0.1,
  cashoutChunkFracMax: 0.1,
  cashoutPriceJitterMin: 5,
  cashoutPriceJitterMax: 5,
};

const MODES = new Set(['read', 'list-cancel']);

function usage() {
  return [
    'Usage: node scripts/market-smoke.js <Account> [read]',
    '       node scripts/market-smoke.js <Account> list-cancel --execute',
    '       node scripts/market-smoke.js --account=<Account> [read]',
    '',
    'Default is read-only dry-run: login, player/load, Gold floor, own listings, own recent sales.',
    'The only live write mode is exactly "list-cancel --execute": create one guarded Gold listing and cancel it by returned id.',
  ].join('\n');
}

function parseOption(token) {
  const match = String(token).match(/^--([^=]+)(?:=(.*))?$/);
  if (!match) return null;
  return { key: match[1], value: match[2] };
}

export function parseMarketSmokeArgs(argv = []) {
  const positionals = [];
  let accountName = null;
  let execute = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const opt = parseOption(token);
    if (!opt) {
      positionals.push(token);
      continue;
    }

    if (opt.key === 'help' || opt.key === 'h') {
      help = true;
    } else if (opt.key === 'execute') {
      execute = true;
    } else if (opt.key === 'account') {
      const value = opt.value ?? argv[++index];
      if (!value) throw new Error(`--account requires a value\n\n${usage()}`);
      accountName = value;
    } else {
      throw new Error(`unknown option --${opt.key}\n\n${usage()}`);
    }
  }

  if (help) return { accountName, execute, help, liveWrite: false, mode: 'read' };
  if (!accountName && positionals.length) accountName = positionals.shift();

  const mode = positionals.shift() || 'read';
  if (!MODES.has(mode)) throw new Error(`unknown mode: ${mode}\n\n${usage()}`);
  if (positionals.length) throw new Error(`unexpected argument: ${positionals[0]}\n\n${usage()}`);
  if (!accountName) throw new Error(usage());

  return {
    accountName,
    execute,
    help,
    liveWrite: mode === 'list-cancel' && execute,
    mode,
  };
}

function playerSummary(state = {}) {
  const player = state.player || {};
  return {
    gold: Number(player.gold ?? 0),
    gems: player.gems ?? null,
    level: player.level ?? null,
    stamina: player.stamina ?? null,
    zolana: player.zenko_balance ?? player.zolana ?? null,
  };
}

function listingSample(row) {
  return {
    id: row.id,
    itemKind: row.itemKind ?? row.item_kind ?? null,
    amount: row.amount ?? row.quantity ?? null,
    priceUsd: row.priceUsd ?? row.price_usd ?? null,
    currency: row.currency ?? null,
    status: row.status ?? row.state ?? null,
  };
}

function saleSample(row) {
  return {
    id: row.id,
    itemKind: row.itemKind ?? row.item_kind ?? null,
    quantity: row.quantity ?? row.amount ?? null,
    priceUsd: row.priceUsd ?? row.price_usd ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

function listingIdFromResult(result) {
  return result?.id ?? result?.listingId ?? result?.listing_id ?? result?.listing?.id ?? null;
}

export function buildMarketSmokePlan({
  args,
  gold,
  floorUsd,
  rng = Math.random,
  cfg = MARKET_SMOKE_DEFAULT_CFG,
} = {}) {
  if (!args?.liveWrite) {
    return {
      action: 'read-only',
      listing: null,
      reason: args?.mode === 'list-cancel' ? 'missing---execute' : 'dry-run',
    };
  }

  const minLot = Math.max(0, Number(cfg.cashoutMinLotGold) || 0);
  const availableGold = Number(gold) || 0;
  const smokeSurplus = Math.min(availableGold, Math.max(minLot, Math.round(availableGold * 0.1)));
  const lot = planGoldListing({
    surplus: smokeSurplus,
    floorUsd,
    rng,
    cfg: { ...cfg, cashoutChunkFracMin: 1, cashoutChunkFracMax: 1 },
  });
  if (!lot) {
    return {
      action: 'skip',
      listing: null,
      reason: 'planner-returned-null',
    };
  }

  return {
    action: 'list-cancel',
    listing: { itemKind: 'gold', quantity: lot.quantity, priceUsd: lot.priceUsd, currency: 'zenko' },
    reason: null,
  };
}

export async function runMarketSmoke(args, deps, client = null) {
  const state = await deps.readPlayerState(client);
  const [floorUsd, ownListings, recentSales] = await Promise.all([
    deps.getGoldFloorUsd(client),
    deps.getMyListings(client),
    deps.getMySales(client, 25),
  ]);

  const player = playerSummary(state);
  const plan = buildMarketSmokePlan({
    args,
    gold: player.gold,
    floorUsd,
    rng: deps.rng ?? Math.random,
    cfg: deps.cfg ?? MARKET_SMOKE_DEFAULT_CFG,
  });

  const summary = {
    account: args.accountName,
    dryRun: !args.liveWrite,
    mode: args.mode,
    writeAttempted: false,
    player,
    market: {
      goldFloorUsd: floorUsd,
      ownListings: {
        count: ownListings.length,
        activeGoldZenko: activeListingCount(ownListings, { itemKind: 'gold', currency: 'zenko' }),
        sample: ownListings.slice(0, 5).map(listingSample),
      },
      recentSales: {
        count: recentSales.length,
        sample: recentSales.slice(0, 5).map(saleSample),
      },
    },
    plan,
    live: null,
  };

  if (!args.liveWrite) return summary;
  if (plan.action !== 'list-cancel' || !plan.listing) return summary;

  summary.writeAttempted = true;
  const listResult = await deps.listGold(client, {
    quantity: plan.listing.quantity,
    priceUsd: plan.listing.priceUsd,
  });
  const listingId = listingIdFromResult(listResult);
  if (!listingId) throw new Error('market-smoke: list result did not include a listing id; refusing blind cancel');
  const cancelResult = await deps.cancelListing(client, listingId);
  summary.live = { listingId, listResult, cancelResult };
  return summary;
}

function defaultDeps() {
  return {
    readPlayerState: (client) => client.api('/api/player/load'),
    getGoldFloorUsd,
    getMyListings,
    getMySales,
    listGold,
    cancelListing,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseMarketSmokeArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  loadEnv();
  const masterKey = requireMasterKey();
  const [account] = accountConfigsFromArgs([args.accountName]);
  const wallet = loadWallet(args.accountName, masterKey);
  const client = new ZenkoClient(wallet, { proxyUrl: account?.proxyUrl });

  try {
    await client.login();
    const summary = await runMarketSmoke(args, defaultDeps(), client);
    summary.address = wallet.address;
    summary.proxy = proxyLabel(account?.proxyUrl);
    console.log(JSON.stringify(summary, null, 2));
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
