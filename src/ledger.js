import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LOG_DIR = join(__dirname, '..', 'logs');

const ASSETS = ['zolana', 'gold', 'gems'];
const DEFAULT_RECENT_LIMIT = 30;
const ZOLANA_WINDOWS = [
  ['h1', 1 * 60 * 60 * 1000],
  ['h6', 6 * 60 * 60 * 1000],
  ['h24', 24 * 60 * 60 * 1000],
];

const cleanAccount = (account) => String(account || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
const numberOrZero = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 1e8) / 1e8;
const eventTimeMs = (event) => {
  const ts = Date.parse(event?.ts || '');
  return Number.isFinite(ts) ? ts : 0;
};
const nowMs = (value) => {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
};
const listingIdOf = (event) => event?.ref?.listingId || event?.ref?.listing_id || event?.meta?.listingId || event?.meta?.listing_id || null;

export function ledgerPath(account, { logDir = DEFAULT_LOG_DIR } = {}) {
  return join(logDir, `ledger-${cleanAccount(account)}.jsonl`);
}

export function normalizeLedgerEvent(account, event = {}) {
  const amounts = {};
  for (const asset of ASSETS) amounts[asset] = numberOrZero(event.amounts?.[asset]);

  return {
    id: event.id || randomUUID(),
    ts: event.ts || new Date().toISOString(),
    account: cleanAccount(account || event.account || 'default'),
    type: event.type || 'unknown',
    status: event.status || 'confirmed',
    amounts,
    tx: event.tx || null,
    ref: event.ref || {},
    meta: event.meta || {},
  };
}

export function appendLedgerEvent(account, event, { logDir = DEFAULT_LOG_DIR } = {}) {
  mkdirSync(logDir, { recursive: true });
  const normalized = normalizeLedgerEvent(account, event);
  appendFileSync(ledgerPath(account, { logDir }), `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

export function readLedgerEvents(account, { logDir = DEFAULT_LOG_DIR } = {}) {
  const path = ledgerPath(account, { logDir });
  if (!existsSync(path)) return [];

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return normalizeLedgerEvent(account, JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function summarizeZolanaWindows(events, zolanaUsd, now) {
  const price = numberOrZero(zolanaUsd);
  const out = {};
  for (const [key, ms] of ZOLANA_WINDOWS) {
    const start = now - ms;
    let spendZolana = 0;
    let revenueZolana = 0;
    let saleCount = 0;
    let spendCount = 0;
    for (const event of events) {
      const t = eventTimeMs(event);
      if (t < start || t > now) continue;
      const zolana = event.amounts?.zolana || 0;
      if (zolana > 0) {
        revenueZolana += zolana;
        if (event.type === 'market_sale') saleCount++;
      } else if (zolana < 0) {
        spendZolana += Math.abs(zolana);
        spendCount++;
      }
    }
    const hours = ms / 3.6e6;
    const netZolana = revenueZolana - spendZolana;
    out[key] = {
      hours,
      spendZolana: roundMoney(spendZolana),
      revenueZolana: roundMoney(revenueZolana),
      netZolana: roundMoney(netZolana),
      revenuePerHour: roundMoney(revenueZolana / hours),
      netPerHour: roundMoney(netZolana / hours),
      revenueUsdPerHour: roundMoney((revenueZolana / hours) * price),
      netUsdPerHour: roundMoney((netZolana / hours) * price),
      saleCount,
      spendCount,
    };
  }
  return out;
}

// Gross Gold income by window: how much was ACTUALLY mined (positive gold, mostly dungeon_claim),
// how much was spent (egg_buy/breed), and the net. "Total earnings" = grossPerHour — spend is NOT
// subtracted (income = all mined output; egg/breeding spend is reinvestment). Differs from the
// dashboard's goldPerHour, which measures the change in BALANCE (income − all spend, including
// feed/evolve, which aren't in the ledger).
function summarizeGoldWindows(events, now) {
  const out = {};
  for (const [key, ms] of ZOLANA_WINDOWS) {
    const start = now - ms;
    let grossGold = 0, spendGold = 0, claimCount = 0;
    for (const event of events) {
      const t = eventTimeMs(event);
      if (t < start || t > now) continue;
      const gold = numberOrZero(event.amounts?.gold);
      if (gold > 0) { grossGold += gold; if (event.type === 'dungeon_claim') claimCount++; }
      else if (gold < 0) spendGold += Math.abs(gold);
    }
    const hours = ms / 3.6e6;
    out[key] = {
      hours,
      grossGold: Math.round(grossGold),
      spendGold: Math.round(spendGold),
      netGold: Math.round(grossGold - spendGold),
      grossPerHour: Math.round(grossGold / hours),
      spendPerHour: Math.round(spendGold / hours),
      netPerHour: Math.round((grossGold - spendGold) / hours),
      claimCount,
    };
  }
  return out;
}

// "Profit today" in USD — blends gross Gold (at the external Gold→USD market rate) and net ZOLANA
// (at the Jupiter rate) into one figure, analogous to the game's own "Today's Net Profit" (2026-07-06,
// owner spotted it in their client). The game doesn't expose the exact formula (not via API, computed
// client-side) — this is an INDEPENDENT estimate on real market rates, not claiming a bit-for-bit match.
//
// Gold — GROSS (grossGold, not netGold): same decision as the "Gold mined/h" headline earlier this
// session — spending Gold on breed/feed turns it into pet tier (reinvestment), it doesn't lose value.
// ZOLANA — NET (revenue−spend): spending ZOLANA (stamina refill) is irreversible and real, must be
// subtracted. If only ONE of the two rates is known, compute from that one alone (don't guess the
// missing one); if neither, null (don't invent a number).
export function estimateProfitUsd({ grossGold = 0, netZolana = 0, goldFloorUsd = null, zolanaPriceUsd = null } = {}) {
  const hasGold = Number.isFinite(goldFloorUsd) && goldFloorUsd > 0;
  const hasZolana = Number.isFinite(zolanaPriceUsd) && zolanaPriceUsd > 0;
  if (!hasGold && !hasZolana) return null;
  const goldUsd = hasGold ? (Number(grossGold) || 0) * goldFloorUsd : 0;
  const zolanaUsd = hasZolana ? (Number(netZolana) || 0) * zolanaPriceUsd : 0;
  return roundMoney(goldUsd + zolanaUsd);
}

// Event counts by type per window (1h/6h/24h) — feeds the dashboard's "flywheel activity" strip
// (hatch/breed/recycle/unplace/vault/forge/sold) so the owner can see the pipeline is ACTUALLY turning
// without scrolling the log by eye. Reuses ZOLANA_WINDOWS so all windows stay in sync.
function summarizeActivityWindows(events, now) {
  const out = {};
  for (const [key, ms] of ZOLANA_WINDOWS) {
    const start = now - ms;
    const byType = {};
    for (const event of events) {
      const t = eventTimeMs(event);
      if (t < start || t > now) continue;
      byType[event.type] = (byType[event.type] || 0) + 1;
    }
    out[key] = byType;
  }
  return out;
}

export function openMarketListingsFromEvents(events = []) {
  const open = new Map();
  for (const event of events) {
    const listingId = listingIdOf(event);
    if (!listingId) continue;
    if (event.type === 'market_list' || event.type === 'market_sync') {
      const priceUsd = numberOrZero(event.meta?.priceUsd ?? event.meta?.price_usd);
      open.set(listingId, {
        listingId,
        itemKind: event.ref?.itemKind || event.ref?.item_kind || event.meta?.itemKind || event.meta?.item_kind || 'item',
        itemId: event.ref?.itemId || event.ref?.item_id || event.meta?.itemId || event.meta?.item_id || null,
        priceUsd,
        synced: event.type === 'market_sync',
      });
    } else if (event.type === 'market_sale' || event.type === 'market_cancel' || event.type === 'market_cancelled') {
      open.delete(listingId);
    }
  }
  return open;
}

function summarizeMarket(events = []) {
  const open = openMarketListingsFromEvents(events);
  let listedCount = 0;
  let syncedCount = 0;
  let soldCount = 0;
  let cancelledCount = 0;
  let soldUsd = 0;
  for (const event of events) {
    if (event.type === 'market_list') listedCount++;
    else if (event.type === 'market_sync') syncedCount++;
    else if (event.type === 'market_sale') {
      soldCount++;
      soldUsd += numberOrZero(event.meta?.priceUsd ?? event.meta?.price_usd);
    } else if (event.type === 'market_cancel' || event.type === 'market_cancelled') {
      cancelledCount++;
    }
  }

  const byKind = {};
  let pendingUsd = 0;
  for (const listing of open.values()) {
    pendingUsd += listing.priceUsd;
    const kind = listing.itemKind || 'item';
    byKind[kind] = byKind[kind] || { count: 0, usd: 0 };
    byKind[kind].count++;
    byKind[kind].usd = roundMoney(byKind[kind].usd + listing.priceUsd);
  }
  return {
    pendingCount: open.size,
    pendingUsd: roundMoney(pendingUsd),
    byKind,
    listedCount,
    syncedCount,
    soldCount,
    cancelledCount,
    soldUsd: roundMoney(soldUsd),
    conversionRate: listedCount > 0 ? roundMoney(soldCount / listedCount) : null,
  };
}

export function summarizeLedger(events = [], zolanaUsd = 0, { recentLimit = DEFAULT_RECENT_LIMIT, now = Date.now() } = {}) {
  const counts = { total: 0, byType: {} };
  const inGame = { goldNet: 0, gemsNet: 0 };
  let spendZolana = 0;
  let revenueZolana = 0;
  const normalizedEvents = [];

  for (const event of events) {
    const normalized = normalizeLedgerEvent(event.account, event);
    normalizedEvents.push(normalized);
    counts.total++;
    counts.byType[normalized.type] = (counts.byType[normalized.type] || 0) + 1;

    const zolana = normalized.amounts.zolana;
    if (zolana < 0) spendZolana += Math.abs(zolana);
    if (zolana > 0) revenueZolana += zolana;

    inGame.goldNet += normalized.amounts.gold;
    inGame.gemsNet += normalized.amounts.gems;
  }

  const pnlZolana = revenueZolana - spendZolana;
  const price = numberOrZero(zolanaUsd);
  const roiPct = spendZolana > 0 ? (pnlZolana / spendZolana) * 100 : null;
  const paybackPct = spendZolana > 0 ? (revenueZolana / spendZolana) * 100 : null;

  return {
    counts,
    realized: {
      spendZolana: roundMoney(spendZolana),
      revenueZolana: roundMoney(revenueZolana),
      pnlZolana: roundMoney(pnlZolana),
      pnlUsd: roundMoney(pnlZolana * price),
    },
    performance: {
      roiPct: roiPct == null ? null : roundMoney(roiPct),
      paybackPct: paybackPct == null ? null : roundMoney(paybackPct),
      remainingZolana: roundMoney(Math.max(0, spendZolana - revenueZolana)),
      paidBack: spendZolana > 0 && revenueZolana >= spendZolana,
    },
    inGame: {
      goldNet: roundMoney(inGame.goldNet),
      gemsNet: roundMoney(inGame.gemsNet),
    },
    zolanaWindows: summarizeZolanaWindows(normalizedEvents, price, nowMs(now)),
    goldWindows: summarizeGoldWindows(normalizedEvents, nowMs(now)),
    activityWindows: summarizeActivityWindows(normalizedEvents, nowMs(now)),
    market: summarizeMarket(normalizedEvents),
    recent: normalizedEvents.slice(-recentLimit),
  };
}
