// Local web dashboard. Reads logs/live-*.json (written by the bot) and serves the page.
// Does NOT log in, does NOT call the game, does NOT touch the master key — just a monitor.
//   node scripts/serve-dashboard.js            # http://localhost:4317
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readLedgerEvents, summarizeLedger, estimateProfitUsd } from '../src/ledger.js';
import { analyzeAccountState } from '../src/account-analysis.js';
import { readRuntimeStatuses } from '../src/runtime-status.js';
import { DEFAULT_REGISTRY_PATH, loadRegistry } from '../src/account-creator.js';
import { proxyLabel } from '../src/accounts.js';
import { appendJupiterPrice, readFloorHistory, readJupiterPriceHistory, latestGoldFloorUsd } from '../src/market-history.js';
import { ZOLANA_MINT } from '../src/stamina.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs');
const PUBLIC = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 4317;

// $ZOLANA/USD rate from Jupiter (2026-07-06) — a source INDEPENDENT of the game (the game already
// confused the owner with a stale/low number earlier in this session). Price API v3, keyless access with
// NO api key: the 0.5 req/sec limit — our once-a-minute poll (≈0.017 RPS) is well within it, no key
// needed. A separate process (this dashboard server), not the 18 bots — so we don't multiply network calls
// for nothing and don't approach the limit by a random coincidence of polls.
const JUPITER_POLL_MS = 60_000;
async function pollJupiterPrice() {
  try {
    const res = await fetch(`https://api.jup.ag/price/v3?ids=${ZOLANA_MINT}`);
    if (!res.ok) return;
    const json = await res.json();
    const usdPrice = Number(json?.[ZOLANA_MINT]?.usdPrice);
    if (usdPrice > 0) appendJupiterPrice(usdPrice, { logDir: LOG_DIR });
  } catch { /* network down / Jupiter is down — skip this poll, not critical */ }
}

function registryBaseAccount(account) {
  return {
    name: account.name,
    address: account.address,
    hasLive: false,
    registryStatus: account.status || 'registered',
    targetSolMin: account.targetSolMin ?? null,
    targetSolMax: account.targetSolMax ?? null,
    proxy: proxyLabel(account.proxyUrl || process.env[account.proxyEnv]),
    player: {},
    counts: { creatures: 0, placed: 0, eggs: 0, pendingEggs: 0, runs: 0, mats: 0 },
    creaturesList: [],
    dungeonRuns: [],
    eggsList: [],
    materialsList: [],
    relicsList: [],
    goldHistory: [],
    zolanaHistory: [],
    log: [],
  };
}

// 24h flows by event type — feeds the "Strategy · breeding conveyor" section on the dashboard.
// summarizeLedger already returns COUNTS by type (activityWindows) and TOTALS across all types at once
// (zolana/goldWindows), but not amount sums BY type — and the section needs specifically "how much ZOLANA
// went to stamina_refill" separately from "how much came in from market_sale". Computed over allEvents in
// collectState (which already reads all ledger-*.jsonl every poll) — a separate endpoint would re-read
// ~15MB of journals a second time on every frontend poll.
export const STRATEGY_FLOW_TYPES = ['breed', 'egg_hatch', 'creature_feed', 'stamina_refill', 'market_sale', 'relic_forge', 'egg_buy'];
const DAY_MS = 24 * 60 * 60 * 1000;
export function summarizeStrategyFlows(events = [], { now = Date.now(), windowMs = DAY_MS } = {}) {
  const start = now - windowMs;
  const out = {};
  for (const type of STRATEGY_FLOW_TYPES) out[type] = { count: 0, gold: 0, zolana: 0 };
  for (const event of events) {
    const bucket = out[event?.type];
    if (!bucket) continue;
    const t = Date.parse(event?.ts || '');
    if (!Number.isFinite(t) || t < start || t > now) continue;
    bucket.count++;
    bucket.gold += Number(event?.amounts?.gold) || 0;
    bucket.zolana += Number(event?.amounts?.zolana) || 0;
  }
  // rounding as in ledger.js (roundMoney): zolana can be fractional, without it the sums accumulate float garbage
  for (const type of STRATEGY_FLOW_TYPES) {
    out[type].gold = Math.round(out[type].gold);
    out[type].zolana = Math.round((out[type].zolana + Number.EPSILON) * 1e8) / 1e8;
  }
  return out;
}

// Sales for the dashboard (2026-07-06, redesign): a "sold" log + total NET by token. MANDATORY dedup by
// ref.listingId — the old soldMarketIds bug wrote one sale up to 19 times (75 raw = 5 real, see memory);
// the raw ledger still contains those duplicates, it can't be summed naively.
export function summarizeSales(events = [], { limit = 50 } = {}) {
  const byListing = new Map();
  for (const e of events) {
    if (e?.type !== 'market_sale') continue;
    const key = e.ref?.listingId || e.id;
    if (byListing.has(key)) continue;
    byListing.set(key, {
      ts: e.ts,
      account: e.account,
      itemKind: e.ref?.itemKind || 'item',
      zolana: Number(e.amounts?.zolana) || 0,
      usd: Number(e.meta?.priceUsd) || 0,
      buyer: e.ref?.buyer || null,
    });
  }
  const sales = [...byListing.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const netZolana = Math.round(sales.reduce((s, x) => s + x.zolana, 0) * 100) / 100;
  const netUsd = Math.round(sales.reduce((s, x) => s + x.usd, 0) * 100) / 100;
  return { count: sales.length, netZolana, netUsd, log: sales.slice(0, limit) };
}

export function collectState({ logDir = LOG_DIR, registryPath = DEFAULT_REGISTRY_PATH, playersOnly = false, now = Date.now() } = {}) {
  const allEvents = [];
  const runtime = readRuntimeStatuses({ logDir });
  const liveByName = new Map();
  if (existsSync(logDir)) {
    for (const f of readdirSync(logDir)) {
      if (!/^live-.*\.json$/.test(f)) continue;
      try {
        const live = JSON.parse(readFileSync(join(logDir, f), 'utf8'));
        if (live?.name) liveByName.set(live.name, { ...live, hasLive: true });
      } catch { /* skip */ }
    }
  }

  const registryAccounts = loadRegistry(registryPath).accounts || [];
  const built = registryAccounts.length
    ? registryAccounts.map((account) => ({
      ...registryBaseAccount(account),
      ...(liveByName.get(account.name) || {}),
      registryStatus: account.status || 'registered',
      proxy: proxyLabel(account.proxyUrl || process.env[account.proxyEnv]),
    }))
    : [...liveByName.values()];

  // Shown set = funded players (registry status `stamina_float_ready`) PLUS any
  // account currently producing a live snapshot — that includes main/spare, the
  // original accounts the bot also farms via `--all`. The un-funded SOL-only
  // collectors (`awaiting_deposit`, no live data) stay hidden. `?all=1` shows all.
  const accounts = playersOnly && registryAccounts.length
    ? built.filter((a) => a.registryStatus === 'stamina_float_ready' || a.hasLive)
    : built;

  accounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const price = accounts.find(a => a.priceUsd)?.priceUsd || 0;
  // "Profit today" (2026-07-06, owner saw an equivalent in the game itself): blends gross Gold (at the
  // external market rate) and net ZOLANA (at the Jupiter rate) over 24h into one USD figure. We DELIBERATELY
  // use Jupiter, not `price` above (that's the GAME'S OWN report via /api/price, read by the bot ONCE at
  // process start and never updated — it goes stale over a long uptime; Jupiter is an independent source,
  // polled once a minute, see pollJupiterPrice).
  const jupiterHistory = readJupiterPriceHistory({ logDir, sinceMs: 0 });
  const jupiterPriceUsd = jupiterHistory.length ? jupiterHistory[jupiterHistory.length - 1].usdPrice : null;
  const goldFloorUsd = latestGoldFloorUsd({ logDir });
  for (const account of accounts) {
    const events = readLedgerEvents(account.name, { logDir });
    allEvents.push(...events);
    account.analytics = summarizeLedger(events, price, { now });
    account.analytics.profitUsd24h = estimateProfitUsd({
      grossGold: account.analytics.goldWindows?.h24?.grossGold,
      netZolana: account.analytics.zolanaWindows?.h24?.netZolana,
      goldFloorUsd,
      zolanaPriceUsd: jupiterPriceUsd,
    });
    account.summary = analyzeAccountState(account, {
      name: account.name,
      address: account.address,
      priceUsd: price,
    });
    account.runtime = runtime[account.name] || null;
  }
  const totalAnalytics = summarizeLedger(allEvents, price, { now });
  totalAnalytics.profitUsd24h = estimateProfitUsd({
    grossGold: totalAnalytics.goldWindows?.h24?.grossGold,
    netZolana: totalAnalytics.zolanaWindows?.h24?.netZolana,
    goldFloorUsd,
    zolanaPriceUsd: jupiterPriceUsd,
  });
  const totalUsd = accounts.reduce((s, a) => s + ((a.player?.zenko_balance || 0) * price), 0);
  const strategyFlows24h = summarizeStrategyFlows(allEvents, { now });
  const sales = summarizeSales(allEvents);
  return { accounts, price, totalUsd, totalAnalytics, serverTime: now, jupiterPriceUsd, goldFloorUsd, strategyFlows24h, sales };
}

// Raw (un-bucketed) floor-by-rarity points + the Jupiter rate for the window — the frontend builds candles
// of the needed timeframe (1m/3m/5m) on the fly, without round-trips to the server on a switch. The data
// volume for a reasonable window (hours) is modest — we serve it as is, not pre-aggregated candles.
export function collectMarketHistory({ logDir = LOG_DIR, hours = 24, now = Date.now() } = {}) {
  const sinceMs = now - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000;
  return {
    floors: readFloorHistory({ logDir, sinceMs }),
    prices: readJupiterPriceHistory({ logDir, sinceMs }),
    serverTime: now,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // /api/state cache (2026-07-06, redesign): collectState synchronously re-reads ALL ledger-*.jsonl
  // (~200MB) — measured 10s/request. The page polls every 15s → the server was busy ⅔ of the time and the
  // first render waited 10s (looked like "the dashboard is empty"). A background warm-up every
  // STATE_REFRESH_MS + serving the last ready snapshot instantly; the first request before warm-up computes it itself (once).
  const STATE_REFRESH_MS = 15_000;
  const stateCache = new Map(); // playersOnly(bool) -> {json, at}
  function refreshState(playersOnly) {
    try { stateCache.set(playersOnly, { json: JSON.stringify(collectState({ playersOnly })), at: Date.now() }); }
    catch (e) { console.error('state refresh err:', e.message); }
  }
  refreshState(true);
  setInterval(() => refreshState(true), STATE_REFRESH_MS);

  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/state')) {
      // Default view = the real farm (funded players only). ?all=1 includes the
      // SOL-only collection wallets too, for funding/ops checks.
      const playersOnly = !/[?&]all=1(?:&|$)/.test(req.url);
      let cached = stateCache.get(playersOnly);
      if (!cached || (Date.now() - cached.at) > 3 * STATE_REFRESH_MS) { refreshState(playersOnly); cached = stateCache.get(playersOnly); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(cached?.json || '{}');
      return;
    }
    if (req.url.startsWith('/api/market-history')) {
      const hoursMatch = /[?&]hours=(\d+(?:\.\d+)?)/.exec(req.url);
      const hours = hoursMatch ? Number(hoursMatch[1]) : 24;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(collectMarketHistory({ hours })));
      return;
    }
    const file = join(PUBLIC, 'dashboard.html');
    if (existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(file));
    } else {
      res.writeHead(500); res.end('dashboard.html missing');
    }
  });

  // Graceful port handling: if the desired port is taken (a stale dashboard is
  // already running), don't crash with an unhandled 'error' stack — log a clean
  // note and fall back to the next free port, up to MAX_PORT_TRIES.
  const basePort = Number(PORT) || 4317;
  const MAX_PORT_TRIES = 10;
  let port = basePort;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (port - basePort < MAX_PORT_TRIES) {
        console.warn(`port ${port} busy (a dashboard may already be running) — trying ${port + 1}…`);
        server.listen(++port);
        return;
      }
      console.error(`\nNo free port in ${basePort}–${port}. A dashboard is likely already running at http://localhost:${basePort}.`);
      console.error('Open that one, or free the port and retry:');
      console.error(`  PowerShell:  Get-NetTCPConnection -LocalPort ${basePort} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
      process.exit(1);
    }
    console.error(`dashboard server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`Zenko dashboard → http://localhost:${port}`);
    if (port !== basePort) console.log(`(port ${basePort} was taken — fell back to ${port})`);
    console.log('(reads logs/live-*.json written by the bot — run `npm run bot` alongside it)');
  });

  pollJupiterPrice(); // right at startup — don't wait the first minute for the first chart point
  setInterval(pollJupiterPrice, JUPITER_POLL_MS);
}
