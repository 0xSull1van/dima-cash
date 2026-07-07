#!/usr/bin/env node
// Discord floor tracker (2026-07-07, owner idea): the official project Discord posts EVERY sale of EVERY
// item in one channel — far richer than the game's thin /api/market/recent-sales. This polls that channel
// every ~30s, parses the sale posts, and writes a live per-rarity + per-trait floor to logs/discord-floor.json.
// The farm can then price off REAL market data (creatureIdealPriceUsd already merges an external floor).
//
// ⚠️ TOKEN / ToS: polling Discord with a USER token = a "self-bot" — a Discord ToS violation that gets the
// account BANNED. Do NOT use your main account's token. Use EITHER:
//   • a Bot token (proper) — set DISCORD_BOT=1 and DISCORD_TOKEN=<bot token>. Needs the bot added to the
//     server (server-admin only), or the channel readable by the bot; OR
//   • a THROWAWAY user account's token — join the server on a burner account, use ITS token (if that
//     account is banned, no loss). Set DISCORD_TOKEN=<token>, leave DISCORD_BOT unset.
// Read-only, one request / poll interval — but the risk is on Discord's side, not ours; a burner is the safe call.
//
// Env:
//   DISCORD_TOKEN            the token (bot or burner-user — see above)
//   DISCORD_BOT=1            treat DISCORD_TOKEN as a Bot token (Authorization: "Bot <token>")
//   DISCORD_SALES_CHANNEL    channel id (default: the id the owner gave)
//   DISCORD_POLL_MS          poll interval (default 30000)
//   DISCORD_WINDOW_H         how many hours of sales to keep for the floor (default 24)
//   ZOLANA_PRICE_USD         optional: also emit floors in $ZOLANA (else USD only)

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSaleMessage } from '../src/discord-sales.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'logs', 'discord-floor.json');

const TOKEN = process.env.DISCORD_TOKEN;
const IS_BOT = process.env.DISCORD_BOT === '1' || process.env.DISCORD_BOT === 'true';
const CHANNEL = process.env.DISCORD_SALES_CHANNEL || '1521354593047412737';
const POLL_MS = Number(process.env.DISCORD_POLL_MS) || 30_000;
const WINDOW_MS = (Number(process.env.DISCORD_WINDOW_H) || 24) * 3600_000;
const ZOL_USD = Number(process.env.ZOLANA_PRICE_USD) || 0;

if (!TOKEN) {
  console.error('discord-floor-tracker: set DISCORD_TOKEN (a BOT token with DISCORD_BOT=1, or a BURNER user token — never your main, see the header).');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';
const authHeader = IS_BOT ? `Bot ${TOKEN}` : TOKEN;

// De-dupe by message id; keep parsed sales within the rolling window.
const seen = new Set();
const sales = []; // { ts, rarity, variant, species, priceUsd }

async function fetchMessages() {
  const res = await fetch(`${API}/channels/${CHANNEL}/messages?limit=100`, {
    headers: { Authorization: authHeader, 'User-Agent': 'zenko-floor-tracker/1.0' },
  });
  if (res.status === 429) { // rate limited — back off for the retry-after
    const body = await res.json().catch(() => ({}));
    const waitMs = Math.max(1000, (Number(body.retry_after) || 1) * 1000);
    console.warn(`discord: 429 rate limited, backing off ${Math.round(waitMs / 1000)}s`);
    return { rateLimitedMs: waitMs };
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`discord: ${res.status} — token invalid or no access to channel ${CHANNEL} (self-bot tokens can also get flagged/banned)`);
  }
  if (!res.ok) throw new Error(`discord: HTTP ${res.status}`);
  return { messages: await res.json() };
}

function ingest(messages) {
  let added = 0;
  for (const m of messages || []) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    const parsed = parseSaleMessage(m); // → { rarity, variant, species, priceUsd } | null  (see src/discord-sales.js)
    if (!parsed || !(parsed.priceUsd > 0)) continue;
    const ts = Date.parse(m.timestamp) || Date.now();
    sales.push({ ts, ...parsed });
    added++;
  }
  return added;
}

function computeFloor() {
  const cutoff = Date.now() - WINDOW_MS;
  while (sales.length && sales[0].ts < cutoff) sales.shift(); // window is roughly time-ordered (Discord returns newest-first, we unshift-sort below)
  const recent = sales.filter((s) => s.ts >= cutoff);
  const byRarity = {}; // rarity -> {min prices}
  const byVariant = {}; // `rarity:variant` -> [prices]
  const push = (map, key, price) => { (map[key] = map[key] || []).push(price); };
  for (const s of recent) {
    const r = String(s.rarity || '').toLowerCase();
    const v = String(s.variant || 'normal').toLowerCase();
    if (!r) continue;
    if (v === 'normal' || v === '') push(byRarity, r, s.priceUsd);
    else push(byVariant, `${r}:${v}`, s.priceUsd);
  }
  const floorUsd = (arr) => Math.min(...arr);
  const median = (arr) => { const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const out = { rarityFloorUsd: {}, rarityClearingUsd: {}, variantFloorUsd: {}, counts: {} };
  for (const [r, arr] of Object.entries(byRarity)) { out.rarityFloorUsd[r] = floorUsd(arr); out.rarityClearingUsd[r] = median(arr); out.counts[r] = arr.length; }
  for (const [k, arr] of Object.entries(byVariant)) { out.variantFloorUsd[k] = floorUsd(arr); out.counts[k] = arr.length; }
  if (ZOL_USD > 0) {
    out.rarityFloorZolana = Object.fromEntries(Object.entries(out.rarityFloorUsd).map(([r, u]) => [r, Math.round(u / ZOL_USD)]));
  }
  return out;
}

function writeFloor() {
  const floor = computeFloor();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: 'discord', channel: CHANNEL, salesWindow: sales.length, ...floor }, null, 2));
}

async function loop() {
  try {
    const r = await fetchMessages();
    if (r.rateLimitedMs) { setTimeout(loop, r.rateLimitedMs); return; }
    const added = ingest(r.messages);
    writeFloor();
    console.log(`discord: +${added} new sales (window ${sales.length}) → ${OUT}`);
  } catch (e) {
    console.error('discord poll error:', e.message);
  }
  setTimeout(loop, POLL_MS);
}

console.log(`discord-floor-tracker → channel ${CHANNEL}, every ${POLL_MS / 1000}s, ${IS_BOT ? 'BOT' : 'user(burner!)'} token → ${OUT}`);
loop();
