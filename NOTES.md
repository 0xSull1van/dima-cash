# Zenko API — reverse-engineered contract

Base: `https://play.zolana.gg` · all game routes under `/api/*` (Next.js route handlers).
Reconstructed from the client JS bundles + validated against the live server (2026-07-02).

## Auth (SIWS-style, headless-reproducible — validated ✅)

1. `GET /api/auth/nonce` → `{ nonce, expiresAt }`
2. Build message, join lines with `\n`:
   ```
   Zenko — sign in
   domain: zolana.gg
   wallet: <base58 address>
   issuedAt: <Date.now() ms>
   nonce: <nonce>

   Signing once authorizes this device to act for 8h. No funds move.
   ```
   (`domain` is the **constant** `zolana.gg`, not the host. Blank line before the last sentence.)
3. `signature = base58( ed25519_detached_sign(utf8(message), secretKey) )`
4. `POST /api/auth/login` `{ wallet, issuedAt, nonce, signature }` → `{ token, expiresAt }` (8h)
5. Every authenticated call sends header **`x-zenko-session: <token>`**.
6. `POST /api/auth/logout` (same header).

Client localStorage key (browser only): `zenko.session.zolana.gg.<wallet>`.

## Gate

- `POST /api/player/create` verifies **on-chain** that the wallet holds ≥ 1 $ZOLANA.
  0 holdings → `403 "Hold at least 1 $ZOLANA to play — you currently hold 0."`
- `player/create` returns `409` if a player already exists → then `GET /api/player/load`.

## Servers / meta

- `GET /api/servers` → `{ servers:[{id:"meadow",name,region:"NA",capacity:60,live}, {id:"blossom",EU}, {id:"sakura",ASIA}] }`
- `GET /api/price` → `{ zolanaPriceUsd }`  (≈ $0.0001326 on 2026-07-02)

## Core-loop endpoints (body shapes confirmed from bundle)

| Endpoint | Method | Body | Notes |
|---|---|---|---|
| `/api/player/create` | POST | `{username}` | gated on ≥1 ZOLANA; 409 if exists |
| `/api/player/load` | GET | — | full player state |
| `/api/egg/grant-starter` | POST | `{}` | one-time starter egg |
| `/api/egg/buy` | POST | `{eggType}` | spends Gold/Gems |
| `/api/egg/incubate` | POST | `{eggId, boost}` | start hatch timer |
| `/api/egg/hatch` | POST | `{eggId}` | pop when ready |
| `/api/creature/place-auto` | POST | `{count}` or `{}` | → `{placed}` |
| `/api/creature/place` | POST | `{creatureId,x,y}` or `{creatureId,unplace:true}` | |
| `/api/creature/feed` | POST | `{creatureId}` | 10-min cooldown |
| `/api/creature/evolve` | POST | `{creatureId, useXp}` | costs Gold |
| `/api/dungeon/start` | POST | `{dungeonId, party:[creatureId...]}` | dungeonId 1..25 (verify on 1st run) |
| `/api/dungeon/claim` | POST | `{runId}` | reveal loot |
| `/api/dungeon/cancel` | POST | `{runId}` | |
| `/api/idle/claim` | POST | — (no body) | passive Gold |
| `/api/daily/claim` | POST | `{}` | daily reward |
| `/api/afk/start` | POST | — | AFK zone (2× stamina regen) |
| `/api/afk/collect` | POST | `{stop}` | |
| `/api/stamina/restore` | POST | `{pack:"full", signature}` | ⚠️ BURNS 50 $ZOLANA — only the explicit stamina-refill path may call this |
| `/api/breed` | POST | `{parentA, parentB, blessed}` | Gold cost (+Gems if `blessed:true`, exact price unconfirmed); `→{bredSuccess}`; sets `last_breed_time`. Bot pairs same-species Adult+ best-effort, lets server reject bad pairs (400/402/409, same as evolve). Automated 2026-07-03. |
| `/api/epoch/claim` | POST | `{}` | free periodic Gems stipend. **Distinct from `/api/epoch/donate`** (still FORBIDDEN). Automated 2026-07-03. |

Dungeon catalog (index → name), each `{region, name, durationSec, staminaCost}`:
1 Sunny Glade … 25 Celestial Apex (see wiki). Region stamina: Meadow 6, Tidal 8, Ember 10, Shadow 14, Celestial 18.

## Other endpoints — reconnaissance (2026-07-03, from live `game_2551.js` chunk, not yet wired into bot.js)

Confirmed **SAFE** (Gold/Gems/free only, no client-side Solana signature near the call site) but not automated —
either low grind value, unknown reward shape, or needs a design decision before wiring up:

| Endpoint | Method | Body | Notes |
|---|---|---|---|
| `/api/dex/claim` | POST | `{milestoneId}` | one-time, →`+gems`. Milestone ID list not yet located in bundle — need another grep pass before this can be automated (no IDs to iterate). |
| `/api/pvp` | GET | — | `→{me:{isChampion}}` |
| `/api/pvp/team` | POST | `{team:[{rowId, formation:"front"\|"back"}]}` | 3 slots, free |
| `/api/pvp/match` | POST | — | reward shape not visible in call site — don't wire up until confirmed, or ledger will silently under-record |
| `/api/relic/craft` | POST | `{relicClass, slot}` | Gold + materials |
| `/api/relic/craft-combat` | POST | `{rarity, stat}` | Gold + materials, can fail (`craftFailed`) |
| `/api/relic/reroll` | POST | `{relicId, mode}` | Gold, scales by rarity |
| `/api/relic/equip` / `/api/relic/unequip` | POST | `{relicId, target, slot}` / `{relicId}` | free. **Automated 2026-07-03** (`handleRelics` + `src/relic-optimizer.js`): best relic per slot onto strongest creatures → party_power ↑ → deeper dungeons. Slot model assumed `slot=relic.slot` (unconfirmed in bundle); best-effort, server rejects invalid (400/402/409), reversible via unequip. |
| `/api/cosmetic/buy` | POST | `{cosmeticId}` | Gems (`price`) — pure sink, no grind value |
| `/api/cosmetic/equip` | POST | `{cosmeticId}` / `{slot, cosmeticId:null}` | free |
| `/api/decor/buy` \| `place` \| `sell` | POST | `{decorType}` / `{decorId,x,y,rotation}` / `{decorId}` | Gold or Gems (per-item), sell refunds 50% |
| `/api/storage/move` | POST | `{itemKind, itemId, store}` | free, kind ∈ creature/relic/cosmetic/egg |
| `/api/storage/upgrade` | POST | `{}` | no client-precomputed cost seen; may price server-side |
| `/api/social/friend` \| `/api/social/like` | POST | `{action, wallet}` / `{owner, like}` | free but needs a target wallet — low automation value solo |
| `/api/creature/quick-evolve` | POST | `{creatureId}` | Gems, skips evolve timer — opt-in candidate, not default (spends scarce Gems) |
| `/api/creature/companion` | POST | `{creatureId}` | free, cosmetic display flag only, no grind value |

**Destructive, SAFE money-wise but MUST stay opt-in-only, never default-on** (matches the stamina-refill treatment —
explicit operator opt-in required, not a silent default flag):

| Endpoint | Method | Body | Notes |
|---|---|---|---|
| `/api/witch-trial/enter` | POST | `{elderIds, squadIds}` | ⚠️ permanently consumes 3 Elder-stage creatures ("Three Elder souls, consumed") |
| `/api/witch-trial/engage` / `resolve` | POST | `{}` → `{runId,seed,squad,witch}` / `{runId, playerMoves, retreatTick}` | battle is simulated **client-side**; server only validates a submitted move log — automating this means reimplementing the battle sim, not just wiring a call |
| `/api/creature/sacrifice` | POST | `{targetId, fodderIds}` | ⚠️ permanently deletes the fodder creatures for bonus XP on target |

**Flagged, not touched:** bundle evidence suggests `/api/gem/craft` (currently in `FORBIDDEN`) may actually cost
Gold + materials only, no signature/treasury nearby — possibly mis-classified alongside gacha/casino defensively.
**Do not move it out of `FORBIDDEN` without independently re-verifying against the live bundle/API yourself** —
this list exists specifically to prevent an accidental real-money call, so the cost of being wrong here is asymmetric.

Confirmed still correctly **UNSAFE**: `/api/gacha/pull` has an explicit real-money branch
(`currency==="zenko"` + `useRealContract` → `sendTransaction` to `zolanaTreasury` with a `signature`/`quoteSig` in
the POST body) alongside a Gold/Gems path — blocking the whole endpoint (current behavior) is correct since one
call shape moves real funds.

Not yet reconned at all: `market/*`, `zothebyz/*` (auction), `casino/play`, `chat/*`, `slots/buy` — assume money-moving
until proven otherwise (matches existing FORBIDDEN posture).

### Marketplace economics (from wiki economy.html, 2026-07-03 — API shapes still unreconned)

The **only in-game way to acquire $ZOLANA** is to SELL farmed output to other players on the
Marketplace — a non-custodial, USD-denominated P2P exchange. The game never mints $ZOLANA for
grinding (stamina refills + 5% market fees flow to treasury and **burn**; grind reward is Gold/Gems).
So "farm ZOLANA" == "sell to a human buyer for ZOLANA".

Trade flow (4 steps): **1 List** (seller lists an owned, idle, tradeable item → item locked; seller
signs NOTHING, moves no funds). **2 Quote** (buyer requests; USD price locks to a $ZOLANA amount for
~90s; two legs returned: seller 95%, treasury 5%). **3 Pay** (the **BUYER** signs one atomic tx paying
both legs; idempotent on signature). **4 Settle** (server verifies both legs on-chain, flips ownership).
→ Selling is **seller-passive**: we only POST a listing, we never sign a Solana tx to sell. $ZOLANA
lands in the seller wallet when/if a buyer buys. Consolidation to the collection wallet then uses the
existing `scripts/sweep-funds.js`.

Tradeable: creatures, relics, cosmetics, eggs (unique) + Gems, **Gold**, materials (fungible stacks).
Guardrails: can't list placed/in-dungeon creatures or equipped relics; Soulbound perfect relics never
sellable; **Gold sales capped 100,000,000 Gold / wallet / rolling 7d** (far above any farm balance).
Gem-lane listings are fee-free & settle instantly in-DB (no wallet); $ZOLANA-lane charges 5% seller fee.
Marketplace unlocks at account Level 5.

⚠️ **Liquidity is the open risk**: a listing only converts to ZOLANA if a *human buyer* pays. Whether
there's real demand to buy farmed Gold/commons for ZOLANA is unknown until we read live listings. Recon
`/api/market/*` **read-only first** (listings, floors, own listings, quote shape) before any auto-list.

### Marketplace API (reconned from bundle chunk `5982.*.js` + live probe, 2026-07-03) ✅

Client calls (`I` = axios-ish; `I.get`=GET, `I.post`=POST):

| Endpoint | Method | Body / query | Notes |
|---|---|---|---|
| `/api/market/browse` | GET | `?kind=gold\|creature\|relic&mine=1&sort=` | live listings |
| `/api/market/recent-sales` | GET | `?kind=&limit=` | completed sales (liquidity proof) |
| `/api/market/my-sales` | GET | `?limit=` | own sales history |
| `/api/market/list` | POST | fungible: `{itemKind, resource:null, quantity, currency, priceUsd}` · unique: `{itemKind, itemId, currency, priceUsd}` · gems lane: `{…, currency:"gems", priceGems}` | **SELLER lists — signs NOTHING, moves no funds.** `currency:"zenko"` = $ZOLANA lane; `priceUsd` = total lot USD |
| `/api/market/cancel` | POST | `{listingId}` | unlist |
| `/api/market/buy-gems` | POST | `{listingId}` | buy a gems-lane listing (in-DB, no wallet) |
| `/api/market/quote` | POST | `{listingId}` | **BUYER** side — locks USD→ZOLANA ~90s |
| `/api/market/buy` | POST | `{quoteId, signature}` | ⚠️ **BUYER signs a 2-leg Solana tx (seller+treasury) — FORBIDDEN, never called by us** |

Listing / sale object shape: `{id, item_kind, item_id, resource, quantity, seller, buyer, price_usd,
price_gems, currency, sold_at, rarity, element, item}`. **Note the $ZOLANA lane's `currency` value is
the string `"zenko"`, not `"zolana"`.** Gold is fungible (`item_id:null`, price is per the whole
`quantity`); creatures/relics are unique (`itemId`).

**Live demand verdict (probe on Zephyr, 2026-07-03): GO.** Gold market is liquid — 29 live gold
listings (27 $ZOLANA-lane) + **50 recent completed gold sales**. Gold price ≈ **$0.0000018–0.000002 per
gold ($1.8–2.0 / million)**; typical lots 200k–500k gold. Creatures: 300 listings / 50 recent sales.
Relics: 300 listings / 50 recent sales — creatures/relics sell for whole-dollar prices vs gold's
fractions (much higher yield, but need valuation + protective filters; deferred).

## "The Witch Trial" update endpoints (game patch 2026-07-03, reconned from bundle)

New endpoints from the biggest update since the Economy Rework (event + endgame + retirement + QoL):

| Endpoint | Method | Body | Cost / class | Status |
|---|---|---|---|---|
| `/api/relic/enhance` | POST | `{relicId}` | **Gold + materials** (`aW(enhance_level,rarity)`), has MAX. No Gems/sig. | ✅ **AUTOMATED** `handleRelicEnhance` (`autoEnhanceRelics`, default on) — enhances equipped relics → party_power ↑, same tier as evolve |
| `/api/gems/hold-claim` | POST | `{}` → `{holderStipend:{gems}}` | Free holder Gem stipend | ✅ already automated in `handleRewards` |
| `/api/creature/favorite` | POST | `{creatureId, favorite}` | Free — sets `is_favorite` (protects from sale) | SAFE, not wired (protective option) |
| `/api/creature/release` | POST | `{creatureId}` | "Let it Go" — **destroys** creature for a one-time Gold payout | ⚠️ destructive → opt-in only |
| `/api/breed/renew` | POST | `{creatureId}` | Resets breed_count to 0, **costs Gems** | ⚠️ Gem sink → opt-in only |
| `/api/altar/ritual` | POST | `{offered}` → `{ascension}` | Mythic Ascension — **consumes** offered Elder Legendaries | ⚠️ destructive/endgame → opt-in only |
| `/api/witch-trial/enter` \| `engage` \| `resolve` | POST | see below | Event: **sacrifices 3 Elders** (Lvl 10+) + real-time boss fight (player dodges, squad auto-battles; client-side sim) | ⚠️ destructive + not automatable without re-implementing the battle sim |

Other update notes: relic **Fortune** now genuinely boosts raid Gold + material drops (relic-optimizer could
prioritize it); creature stat cards now show true rarity-power (Mythical ×4, Legendary ×2.8); 3 new servers
(Haneul, Lotus, Fuji); ZH/JA localization; titles. Our farm accounts (commons, Lvl 5-7, Baby–Adult) can't
reach the endgame content (Witch Trial needs Lvl 10 + 3 Elders; Mythic Ascension needs Elder Legendaries).

## Money-safety rule for the bot

Never call through the generic `act()` path: `stamina/restore`, `market/*`, `gacha/pull` (Gem), `egg/buy` with Gems, `epoch/donate`,
`zothebyz/*`, `casino/play`, or anything that signs a Solana tx. These move funds. The bot only
grinds free/Gold actions by default. Stamina refill is the one explicit exception requested by the
operator: when enabled, it sends a 50 $ZOLANA Token-2022 transfer to the treasury, passes the
transaction signature to `/api/stamina/restore`, refreshes player state, and resumes dungeon runs.
Same opt-in-only bar applies to anything destructive-but-free (`witch-trial/enter`, `creature/sacrifice`,
`relic/dismantle`) — these don't move funds but permanently destroy owned creatures/relics, so they must never
be a default-on flag; wire them up only on explicit request, same tier as `autoBuyStamina`.

## Explicitly out of scope

Automated multi-wallet registration (generate N wallets, auto-create a player on each, fund and run the bot
across all of them) was requested and declined 2026-07-03 — Zenko's own reward mechanics (holder-tied Gem
stipend scaling with $ZOLANA balance, account-level gate on the F2P stipend, explicitly described in their FAQ
as "keeps bots out") are gated per-wallet specifically to prevent this, and farmed output sells on the real
marketplace for $ZOLANA. Scaling accounts specifically to multiply per-wallet-gated rewards is sybil abuse of
that mechanism regardless of how the new wallets get funded. `main` + `spare` remain the two accounts this bot
runs. If a genuine single extra personal/failover wallet is ever needed, that's a separate, narrower ask —
raise it explicitly rather than reusing this bot's multi-account path.
