// Юнит-тест логики бота на мок-клиенте (без сети, без мастер-ключа).
// Проверяем: money-guard, климбер глубины, автоэволюцию, клейм.
import { ZenkoBot } from '../src/bot.js';
import { CREATURE_FLOOR_SEED_USD, CREATURE_VARIANT_PRICE_OVERRIDE_USD } from '../src/marketplace.js';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// мок-клиент: записывает вызовы, отдаёт заранее заданные ответы/ошибки
function mockClient(handler) {
  return {
    address: 'MockWa11etAddr1111111111111111111111111111',
    calls: [],
    async login() {},
    async api(path, body) { this.calls.push({ path, body }); return handler(path, body); },
  };
}

// --- 1) money-guard: запретные эндпоинты кидают BLOCKED ---
{
  const bot = new ZenkoBot(mockClient(() => ({})), { name: 't1' });
  let blocked = false;
  try { await bot.act('/api/stamina/restore', { pack: 1, signature: 'x' }); }
  catch (e) { blocked = /BLOCKED/.test(e.message); }
  ok(blocked, 'stamina/restore must be blocked');
  for (const p of ['/api/market/list', '/api/gacha/pull', '/api/epoch/donate']) {
    let b = false; try { await bot.act(p, {}); } catch (e) { b = /BLOCKED/.test(e.message); }
    ok(b, `${p} must be blocked`);
  }
  // regression guard: breed/epoch-claim were added as safe (Gold/free, no signature) — must stay callable
  for (const p of ['/api/breed', '/api/epoch/claim']) {
    let b = false; try { await bot.act(p, {}); } catch (e) { b = /BLOCKED/.test(e.message); }
    ok(!b, `${p} must NOT be blocked`);
  }
}

// --- 2) климбер глубины: успех → +1; power-ошибка → потолок вниз ---
{
  let failAtOrAbove = 99; // клиент отказывает по силе на этой глубине и выше
  const client = mockClient((path, body) => {
    if (path === '/api/dungeon/start') {
      if (body.dungeonId >= failAtOrAbove) { const e = new Error('too weak'); e.status = 400; e.bodyText = 'Party power too low'; throw e; }
      return { ok: true };
    }
    return {};
  });
  const bot = new ZenkoBot(client, { name: 't2', afkZone: false, autoEvolve: false, feed: false, ledger: false });
  const creatures = [1, 2, 3].map(i => ({ id: 'c' + i, stage: 'Adult', level: 5, plot_x: 1 }));
  const stateOf = () => ({ player: { gold: 999999 }, creatures, eggs: [], dungeonRuns: [], materials: [] });

  await bot.handleDungeons(stateOf()); // d1 ok -> depth becomes 2
  ok(bot.depth === 2, `depth climbs after success (got ${bot.depth})`);
  await bot.handleDungeons(stateOf()); // d2 ok -> 3
  await bot.handleDungeons(stateOf()); // d3 ok -> 4
  ok(bot.depth === 4, `depth keeps climbing (got ${bot.depth})`);

  // теперь стенка на d4
  failAtOrAbove = 4;
  await bot.handleDungeons(stateOf()); // d4 fails -> ceiling 3, depth 3
  ok(bot.depthCeiling === 3 && bot.depth === 3, `ceiling backs off on power error (ceil ${bot.depthCeiling}, depth ${bot.depth})`);
  await bot.handleDungeons(stateOf()); // should run d3 (<=ceiling), success -> depth 4 again but won't probe until cooldown
  const startedDepths = client.calls.filter(c => c.path === '/api/dungeon/start').map(c => c.body.dungeonId);
  ok(startedDepths.includes(3) && Math.max(...startedDepths) === 4, `runs within ceiling, tried up to 4 (${startedDepths.join(',')})`);
}

// --- 3) автоэволюция: зовёт evolve для не-Elder, пропускает Elder ---
{
  const client = mockClient((path) => { if (path === '/api/creature/evolve') return { ok: true }; return {}; });
  const bot = new ZenkoBot(client, { name: 't3' });
  const state = { player: { gold: 500000 }, creatures: [
    { id: 'a', stage: 'Adult', xp: 300 }, { id: 'b', stage: 'Elder', xp: 999 }, { id: 'c', stage: 'Baby', xp: 50 },
  ], eggs: [], dungeonRuns: [], materials: [] };
  await bot.handleEvolve(state);
  const evolved = client.calls.filter(c => c.path === '/api/creature/evolve').map(c => c.body.creatureId);
  ok(evolved.includes('a') && evolved.includes('c') && !evolved.includes('b'), `evolves non-Elder, skips Elder (${evolved.join(',')})`);
  ok(evolved[0] === 'a', `evolves highest-XP first (${evolved.join(',')})`);
}

// --- 3b) evolve stops after server-side Gold shortage instead of trying the whole roster ---
{
  const client = mockClient((path) => {
    if (path === '/api/creature/evolve') {
      const e = new Error('not enough gold');
      e.status = 402;
      e.bodyText = '{"error":"Not enough Gold"}';
      throw e;
    }
    return {};
  });
  const bot = new ZenkoBot(client, { name: 't3b', ledger: false });
  const state = { player: { gold: 500000 }, creatures: [
    { id: 'a', stage: 'Adult', xp: 300 }, { id: 'b', stage: 'Adult', xp: 200 }, { id: 'c', stage: 'Baby', xp: 50 },
  ], eggs: [], dungeonRuns: [], materials: [] };
  await bot.handleEvolve(state);
  const calls = client.calls.filter(c => c.path === '/api/creature/evolve');
  ok(calls.length === 1, `stops evolve after 402 (${calls.length} calls)`);
}

// --- 3c) Relic Forge: enhance EQUIPPED relics only, respect gold reserve, opt-in flag ---
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't3c', autoEnhanceRelics: true, minGoldReserve: 1000, ledger: false });
  const relics = [
    { id: 'r1', equipped_on: 'c1', enhance_level: 0 },
    { id: 'r2', equipped_on: 'c2', enhance_level: 2 },
    { id: 'r3', equipped_on: null },                 // unequipped — must skip
    { id: 'r4', equipped_on: 'c3', listed: true },   // listed — must skip
  ];
  await bot.handleRelicEnhance({ player: { gold: 500000 }, creatures: [], relics, eggs: [], dungeonRuns: [], materials: [] });
  const enh = client.calls.filter(c => c.path === '/api/relic/enhance').map(c => c.body.relicId);
  ok(enh.length === 2 && enh.includes('r1') && enh.includes('r2'), `enhances only equipped relics (${enh.join(',')})`);

  const client2 = mockClient(() => ({}));
  const bot2 = new ZenkoBot(client2, { name: 't3c2', autoEnhanceRelics: true, minGoldReserve: 1000, ledger: false });
  await bot2.handleRelicEnhance({ player: { gold: 500 }, creatures: [], relics, eggs: [], dungeonRuns: [], materials: [] });
  ok(client2.calls.filter(c => c.path === '/api/relic/enhance').length === 0, 'no enhance when gold ≤ reserve');

  const client3 = mockClient(() => ({}));
  const bot3 = new ZenkoBot(client3, { name: 't3c3', autoEnhanceRelics: false, ledger: false });
  await bot3.handleRelicEnhance({ player: { gold: 500000 }, creatures: [], relics, eggs: [], dungeonRuns: [], materials: [] });
  ok(client3.calls.filter(c => c.path === '/api/relic/enhance').length === 0, 'no enhance when flag off');
}

// --- 4) клейм готового забега; активный не трогает ---
{
  const now = Date.now();
  const client = mockClient((path) => { if (path === '/api/dungeon/claim') return { dungeonRewards: { gold: 512 } }; return {}; });
  const bot = new ZenkoBot(client, { name: 't4', autoEvolve: false, afkZone: false, feed: false });
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  const state = { player: { gold: 0 }, creatures: [], eggs: [], materials: [], dungeonRuns: [
    { id: 'r1', status: 'active', ready_at: new Date(now - 1000).toISOString(), party: [] }, // готов
    { id: 'r2', status: 'active', ready_at: new Date(now + 60000).toISOString(), party: [] }, // ещё бежит
  ] };
  await bot.handleDungeons(state);
  const claimed = client.calls.filter(c => c.path === '/api/dungeon/claim').map(c => c.body.runId);
  ok(claimed.includes('r1') && !claimed.includes('r2'), `claims finished run only (${claimed.join(',')})`);
  ok(ledger.some(e => e.type === 'dungeon_claim' && e.amounts?.gold === 512 && e.ref?.runId === 'r1'),
    `records dungeon claim reward (${JSON.stringify(ledger)})`);
}

// --- 5) награды: клеймит невыполненные квесты, пропускает уже забранный онбординг, берёт стипенд ---
{
  const client = mockClient((path) => {
    if (path === '/api/quests/claim') return { reward: { gold: 100 } };
    if (path === '/api/gems/hold-claim') return { gems: 9 };
    return {};
  });
  const bot = new ZenkoBot(client, { name: 't5', autoEvolve: false, afkZone: false, feed: false, ledger: false });
  const state = { player: { gold: 0, quest_claims: { o_place: Date.now() } }, creatures: [], eggs: [], dungeonRuns: [], materials: [] };
  await bot.handleRewards(state);
  const q = client.calls.filter(c => c.path === '/api/quests/claim').map(c => c.body.questId);
  ok(!q.includes('o_place'), 'skips already-claimed onboarding quest');
  ok(q.includes('o_own4') && q.includes('d_gold'), `attempts unclaimed quests (${q.length} tried)`);
  ok(client.calls.some(c => c.path === '/api/gems/hold-claim'), 'claims holder gem stipend');
  // троттл: второй вызов сразу — ничего не шлёт
  const before = client.calls.length;
  await bot.handleRewards(state);
  ok(client.calls.length === before, 'rewards throttled (no repeat within window)');
}

// --- 6) тир-прогрессия яиц: <20 питомцев → basic; ≥20 → элементные 50k ---
{
  const mk = (nCreatures, gold) => {
    const client = mockClient(() => ({}));
    const bot = new ZenkoBot(client, { name: 't6', autoBuyEggs: true, elementalEggAfter: 20, minGoldReserve: 2500, afkZone: false, autoEvolve: false, feed: false });
    const state = { player: { gold }, creatures: Array.from({ length: nCreatures }, (_, i) => ({ id: 'c' + i, plot_x: 1 })), eggs: [], dungeonRuns: [], materials: [] };
    return { client, bot, state };
  };
  // мало питомцев → basic
  let { client, bot, state } = mk(5, 100000);
  let ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  await bot.handleEggs(state);
  let buys = client.calls.filter(c => c.path === '/api/egg/buy').map(c => c.body.eggType);
  ok(buys[0] === 'basic', `<20 creatures buys basic (got ${buys[0]})`);
  ok(ledger.some(e => e.type === 'egg_buy' && e.amounts?.gold === -2500 && e.ref?.eggType === 'basic'),
    `records basic egg spend (${JSON.stringify(ledger)})`);
  // 20+ питомцев, есть 50k → элементное
  ({ client, bot, state } = mk(22, 100000));
  ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  await bot.handleEggs(state);
  buys = client.calls.filter(c => c.path === '/api/egg/buy').map(c => c.body.eggType);
  ok(buys[0] && buys[0] !== 'basic' && ['forest','ocean','mountain','volcano','sky'].includes(buys[0]), `≥20 creatures buys elemental (got ${buys[0]})`);
  // 20+ питомцев но Gold < 50k+reserve → не покупает
  ok(ledger.some(e => e.type === 'egg_buy' && e.amounts?.gold === -50000 && e.ref?.eggType === buys[0]),
    `records elemental egg spend (${JSON.stringify(ledger)})`);
  ({ client, bot, state } = mk(22, 40000));
  await bot.handleEggs(state);
  buys = client.calls.filter(c => c.path === '/api/egg/buy');
  ok(buys.length === 0, 'skips elemental when gold insufficient');
}

// --- 6b) regression: hatched eggs stay in state.eggs forever (server never removes them) —
// the buy gate must count PENDING eggs only, not lifetime eggs, or buying dies permanently
// after the 4th hatch. Found live on main/spare 2026-07-02 (21-22 hatched eggs, 0 buys ever).
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't6b', autoBuyEggs: true, minGoldReserve: 0, afkZone: false, autoEvolve: false, feed: false, ledger: false });
  const manyHatched = Array.from({ length: 21 }, (_, i) => ({ id: 'h' + i, status: 'hatched' }));
  const state = { player: { gold: 100000 }, creatures: [], eggs: manyHatched, dungeonRuns: [], materials: [] };
  await bot.handleEggs(state);
  const buys = client.calls.filter(c => c.path === '/api/egg/buy');
  ok(buys.length === bot.cfg.eggQueueTarget, `buys despite 21 lifetime (hatched) eggs in state.eggs (got ${buys.length})`);
}

// --- 7) auto stamina: buys a full refill before starting a dungeon when stamina is low ---
{
  const creatures = [1, 2, 3].map(i => ({ id: 's' + i, stage: 'Adult', level: 5, plot_x: 1 }));
  const lowState = { player: { gold: 100000, stamina: 0, zenko_balance: 100000 }, creatures, eggs: [], dungeonRuns: [], materials: [] };
  const fullState = { ...lowState, player: { ...lowState.player, stamina: 180 } };
  let paymentCalls = 0;
  const client = mockClient((path, body) => {
    if (path === '/api/stamina/restore') return { ok: true, body };
    if (path === '/api/player/load') return fullState;
    if (path === '/api/dungeon/start') return { ok: true };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't7',
    autoBuyStamina: true,
    staminaPayment: async (_wallet, { pack, amountZolana }) => {
      paymentCalls++;
      ok(pack === 'full', `uses full stamina pack (got ${pack})`);
      ok(amountZolana === 150, `uses the current 150 ZOLANA refill cost (got ${amountZolana}) — was 50 until the 2026-07-05 stale-price incident (server raised it, "Payment was too small" burned real ZOLANA fleet-wide until fixed)`);
      return 'sig-refill-1';
    },
    afkZone: false,
    autoEvolve: false,
    feed: false,
    persistStaminaPending: false,
  });
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });

  await bot.handleDungeons(lowState);

  const restore = client.calls.find(c => c.path === '/api/stamina/restore');
  const start = client.calls.find(c => c.path === '/api/dungeon/start');
  ok(paymentCalls === 1, `creates one stamina payment (got ${paymentCalls})`);
  ok(restore?.body?.pack === 'full' && restore?.body?.signature === 'sig-refill-1',
    `submits refill with pack+signature (${JSON.stringify(restore?.body)})`);
  ok(client.calls.some(c => c.path === '/api/player/load'), 'refreshes state after refill');
  ok(!!start, 'starts dungeon after refill');
  ok(ledger.some(e => e.type === 'stamina_refill' && e.amounts?.zolana === -150 && e.tx === 'sig-refill-1' && e.ref?.dungeonId === 1),
    `records stamina refill spend (${JSON.stringify(ledger)})`);
}

// --- 8) auto stamina: retries a pending signature instead of creating a second payment ---
{
  const creatures = [1, 2, 3].map(i => ({ id: 'p' + i, stage: 'Adult', level: 5, plot_x: 1 }));
  const lowState = { player: { gold: 100000, stamina: 0, zenko_balance: 100000 }, creatures, eggs: [], dungeonRuns: [], materials: [] };
  const fullState = { ...lowState, player: { ...lowState.player, stamina: 180 } };
  let paymentCalls = 0;
  let restoreCalls = 0;
  const client = mockClient((path, body) => {
    if (path === '/api/stamina/restore') {
      restoreCalls++;
      ok(body.signature === 'sig-pending', `reuses pending signature (got ${body.signature})`);
      if (restoreCalls === 1) {
        const e = new Error('chain down');
        e.status = 503;
        e.bodyText = "Couldn't reach the chain";
        throw e;
      }
      return { ok: true };
    }
    if (path === '/api/player/load') return fullState;
    if (path === '/api/dungeon/start') return { ok: true };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't8',
    autoBuyStamina: true,
    staminaPayment: async () => {
      paymentCalls++;
      return 'sig-pending';
    },
    staminaRefillRetryMs: 0,
    persistStaminaPending: false,
    afkZone: false,
    autoEvolve: false,
    feed: false,
    ledger: false,
  });

  await bot.handleDungeons(lowState);
  await bot.handleDungeons(lowState);

  const starts = client.calls.filter(c => c.path === '/api/dungeon/start');
  ok(paymentCalls === 1, `does not create a second payment after chain failure (got ${paymentCalls})`);
  ok(restoreCalls === 2, `retries restore endpoint with pending signature (got ${restoreCalls})`);
  ok(starts.length === 1, `starts only after restore succeeds (got ${starts.length})`);
}

// --- 8b) STALE PRICE MONEY-SAFETY 2026-07-05: found live — server raised the stamina-refill price
//     (50→150 ZOLANA) and the bot kept sending REAL on-chain payments at the stale (too-low) amount
//     every staminaRefillRetryMs (2min default). Each rejection cleared the pending signature, so the
//     NEXT attempt sent a FRESH real payment — burning real ZOLANA fleet-wide with zero stamina
//     credited, indefinitely, until a human noticed and fixed the constant. Fix: a "too small"
//     rejection now backs off staminaPriceStaleBackoffMs (long) instead of staminaRefillRetryMs
//     (short) — retrying with the same known-wrong amount cannot ever succeed, only burn more money.
{
  const creatures = [1, 2, 3].map(i => ({ id: 'p' + i, stage: 'Adult', level: 5, plot_x: 1 }));
  const lowState = { player: { gold: 100000, stamina: 0, zenko_balance: 100000 }, creatures, eggs: [], dungeonRuns: [], materials: [] };
  let paymentCalls = 0;
  const staleClient = mockClient((path) => {
    if (path === '/api/stamina/restore') {
      const e = new Error('bad'); e.status = 400; e.bodyText = '{"error":"Payment was too small for this pack."}'; throw e;
    }
    return {};
  });
  const bot = new ZenkoBot(staleClient, {
    name: 't8b', autoBuyStamina: true, persistStaminaPending: false,
    staminaRefillRetryMs: 5, staminaPriceStaleBackoffMs: 10_000, // short vs long, deliberately far apart for the test
    staminaPayment: async () => { paymentCalls++; return 'sig-' + paymentCalls; },
  });

  const first = await bot.handleStaminaRefill(lowState, 1, 6);
  ok(first === false, 'refill attempt reports failure');
  ok(paymentCalls === 1, 'sends one real on-chain payment attempt');
  await sleep(20); // longer than staminaRefillRetryMs(5ms) but far shorter than staminaPriceStaleBackoffMs(10s)
  const second = await bot.handleStaminaRefill(lowState, 1, 6);
  ok(second === false && paymentCalls === 1,
    `does NOT send a second real payment within the stale-price backoff window (paymentCalls=${paymentCalls}) — a short retry here would burn more real ZOLANA on the same known-bad amount`);
  ok(bot.recentLog.some(l => /STALE PRICE/.test(l)), `logs a distinctly-flaggable stale-price line (log: ${JSON.stringify(bot.recentLog)})`);
}

// --- 8c) regression: a NON-price-related 400 still uses the normal short retry (the long backoff is
//     specific to "too small" — an unrelated rejection reason must not be slowed down needlessly) ---
{
  const creatures = [1, 2, 3].map(i => ({ id: 'p' + i, stage: 'Adult', level: 5, plot_x: 1 }));
  const lowState = { player: { gold: 100000, stamina: 0, zenko_balance: 100000 }, creatures, eggs: [], dungeonRuns: [], materials: [] };
  let paymentCalls = 0;
  const otherErrClient = mockClient((path) => {
    if (path === '/api/stamina/restore') {
      const e = new Error('bad'); e.status = 400; e.bodyText = '{"error":"Some other validation failure"}'; throw e;
    }
    return {};
  });
  const bot = new ZenkoBot(otherErrClient, {
    name: 't8c', autoBuyStamina: true, persistStaminaPending: false,
    staminaRefillRetryMs: 5, staminaPriceStaleBackoffMs: 10_000,
    staminaPayment: async () => { paymentCalls++; return 'sig-' + paymentCalls; },
  });
  await bot.handleStaminaRefill(lowState, 1, 6);
  await sleep(20); // longer than the short retry — should be allowed to try again
  await bot.handleStaminaRefill(lowState, 1, 6);
  ok(paymentCalls === 2, `non-price 400 uses the normal SHORT retry, not the long stale-price backoff (paymentCalls=${paymentCalls})`);
  ok(!bot.recentLog.some(l => /STALE PRICE/.test(l)), 'does not mislabel an unrelated 400 as a stale price');
}

// --- 9) tick writes fresh state after actions, not the stale pre-action snapshot ---
{
  const initialState = { player: { gold: 1, gems: 0, level: 1, xp: 0, stamina: 0 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] };
  const freshState = { ...initialState, player: { ...initialState.player, gold: 999, stamina: 180 } };
  let loadCalls = 0;
  const client = mockClient((path) => {
    if (path === '/api/player/load') return ++loadCalls === 1 ? initialState : freshState;
    if (path === '/api/price') return { zolanaPriceUsd: 0.01 };
    return {};
  });
  const bot = new ZenkoBot(client, { name: 't9', autoBuyEggs: false, autoBuyStamina: false, autoEvolve: false, afkZone: false, feed: false });
  bot.firstTick = false;
  bot.handleEggs = async () => {};
  bot.handlePlacement = async () => {};
  bot.handleDungeons = async () => {};
  bot.handleClaims = async () => {};
  bot.handleRewards = async () => {};
  let liveState = null;
  bot.writeLive = (state) => { liveState = state; };

  await bot.tick();

  ok(loadCalls >= 2, `tick reloads state before live write (loads=${loadCalls})`);
  ok(liveState?.player?.gold === 999 && liveState?.player?.stamina === 180,
    `live state is fresh (${JSON.stringify(liveState?.player)})`);
}

// --- 10) breed: tier-climb same-species Adult+ pair (planBreedPair), cost-tracked, throttled ---
{
  const client = mockClient((path) => { if (path === '/api/breed') return { bredSuccess: true }; return {}; });
  const bot = new ZenkoBot(client, { name: 't10', autoEvolve: false, afkZone: false, feed: false });
  // new breeder gates: Adult+, happiness≥50, breed_count<8, off cooldown, rarity within window
  const creatures = [
    { id: 'a1', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', happiness: 100 },
    { id: 'a2', species: 'fox', stage: 'Adult', level: 8, rarity: 'Uncommon', happiness: 100 },
    { id: 'a3', species: 'owl', stage: 'Adult', level: 9, rarity: 'Uncommon', happiness: 100 }, // lone species — no partner
    { id: 'a4', species: 'fox', stage: 'Baby', level: 1, rarity: 'Uncommon', happiness: 100 },  // too young
  ];
  const state = { player: { gold: 999999 }, creatures, eggs: [], dungeonRuns: [], materials: [] };
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });

  await bot.handleBreed(state);
  const calls = client.calls.filter(c => c.path === '/api/breed');
  ok(calls.length === 1, `attempts exactly one breed (${calls.length})`);
  const pairIds = new Set([calls[0]?.body?.parentA, calls[0]?.body?.parentB]);
  ok(pairIds.size === 2 && pairIds.has('a1') && pairIds.has('a2'),
    `pairs the two same-species fox Adults, not lone/Baby (${JSON.stringify(calls[0]?.body)})`);
  ok(calls[0]?.body?.blessed === false, 'blessed defaults to false');
  ok(ledger.some(e => e.type === 'breed' && e.amounts?.gold < 0 && e.meta?.costEstimated === true),
    `records breed event WITH estimated Gold cost (50% refund on fail handled in code) (${JSON.stringify(ledger)})`);

  const before = client.calls.length;
  await bot.handleBreed(state);
  ok(client.calls.length === before, 'breed throttled (no repeat within window)');
}

// --- 10b) BREED FROM VAULT 2026-07-05 (owner: "можно же с сейфа придить") — end-to-end proof through
//     the FULL call chain, not just planBreedPair in isolation. Regression guard: busyIds() (used by
//     dispatchRuns/idleRoster) intentionally marks stored:true as busy — if handleBreed reused that
//     SAME set for planBreedPair, the vaulted creature would be filtered out before isBreedEligible
//     ever ran, silently making the vault-breeding fix dead code. Must use dungeonBusyIds() instead.
{
  const client = mockClient((path) => { if (path === '/api/breed') return { bredSuccess: true }; return {}; });
  const bot = new ZenkoBot(client, { name: 't10b', autoEvolve: false, afkZone: false, feed: false });
  const creatures = [
    { id: 'vaulted', species: 'fox', stage: 'Elder', level: 40, rarity: 'Uncommon', happiness: 100, stored: true },
    { id: 'active', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', happiness: 100 },
  ];
  const state = { player: { gold: 999999 }, creatures, eggs: [], dungeonRuns: [], materials: [] };
  await bot.handleBreed(state);
  const calls = client.calls.filter(c => c.path === '/api/breed');
  ok(calls.length === 1, `breeds using the vaulted creature as a parent, not excluded as "busy" (${calls.length} calls)`);
  const pairIds = new Set([calls[0]?.body?.parentA, calls[0]?.body?.parentB]);
  ok(pairIds.has('vaulted') && pairIds.has('active'), `pair includes the vaulted parent (${JSON.stringify(calls[0]?.body)})`);
}

// --- 10c) VAULT SWAP end-to-end 2026-07-05 (owner: "надо для автоматизации") — proves the two
//     storage/move calls fire in the safe order (evict weak THEN admit strong, never asks for a slot
//     over cap) through the real handleVaultSwap → planVaultSwap chain, not just the isolated planner.
{
  const client = mockClient((path) => { if (path === '/api/storage/move') return {}; return {}; });
  const bot = new ZenkoBot(client, { name: 't10c', autoVaultSwap: true, autoEvolve: false, afkZone: false, feed: false });
  const creatures = [
    // strongest-active is the pickRecycleTarget protect pick (must NOT be evicted); without it, the
    // lone active Rare+ below would be both "weakest" and "strongest" and self-protect out of the plan.
    { id: 'strongest-active', species: 'wolf', stage: 'Elder', level: 30, rarity: 'Legendary' },
    { id: 'weak-active', species: 'fox', stage: 'Baby', level: 1, rarity: 'Rare' },
    { id: 'strong-stored', species: 'owl', stage: 'Adult', level: 10, rarity: 'Epic', stored: true },
  ];
  const state = { player: { gold: 999999 }, creatures, eggs: [], dungeonRuns: [], materials: [] };
  const swapped = await bot.handleVaultSwap(state);
  ok(swapped === true, 'handleVaultSwap reports success');
  const moves = client.calls.filter(c => c.path === '/api/storage/move');
  ok(moves.length === 2, `exactly 2 storage/move calls (${moves.length})`);
  ok(moves[0]?.body?.itemId === 'weak-active' && moves[0]?.body?.store === true,
    `evicts the weak active creature FIRST, freeing the slot (${JSON.stringify(moves[0]?.body)})`);
  ok(moves[1]?.body?.itemId === 'strong-stored' && moves[1]?.body?.store === false,
    `admits the strong stored creature SECOND, into the freed slot (${JSON.stringify(moves[1]?.body)})`);
}

// --- 10d) VAULT SWAP: off by default (opt-in, separate from autoVaultWhenFull) ---
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't10d', autoEvolve: false, afkZone: false, feed: false }); // autoVaultSwap not set → default false
  const state = {
    player: { gold: 999999 },
    creatures: [
      { id: 'weak-active', species: 'fox', stage: 'Baby', level: 1, rarity: 'Rare' },
      { id: 'strong-stored', species: 'owl', stage: 'Adult', level: 10, rarity: 'Epic', stored: true },
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };
  ok(await bot.handleVaultSwap(state) === false, 'autoVaultSwap defaults OFF — no-op even with a valid pair present');
  ok(!client.calls.some(c => c.path === '/api/storage/move'), 'no storage/move call when disabled');
}

// --- 10e) VAULT SWAP: throttled — a second call right after a successful swap is a no-op ---
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't10e', autoVaultSwap: true, autoEvolve: false, afkZone: false, feed: false });
  const state = {
    player: { gold: 999999 },
    creatures: [
      { id: 'strongest-active', species: 'wolf', stage: 'Elder', level: 30, rarity: 'Legendary' },
      { id: 'weak-active', species: 'fox', stage: 'Baby', level: 1, rarity: 'Rare' },
      { id: 'strong-stored', species: 'owl', stage: 'Adult', level: 10, rarity: 'Epic', stored: true },
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };
  ok(await bot.handleVaultSwap(state) === true, 'first call swaps');
  const callsAfterFirst = client.calls.length;
  ok(await bot.handleVaultSwap(state) === false, 'immediate second call is throttled (cooldown window)');
  ok(client.calls.length === callsAfterFirst, 'throttled call makes no new API calls');
}

// --- 10f) VAULT INTAKE end-to-end 2026-07-06 (owner: "пусть бридятся, только в сейфе, нужно
//     перекидывать их") — a fresh, non-exhausted Uncommon is moved INTO the vault to breed there for
//     free, keeping the strongest runner untouched.
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't10f', autoBreedingPipeline: true, autoEvolve: false, afkZone: false, feed: false });
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  const state = {
    player: { gold: 999999 },
    creatures: [
      { id: 'strongest-runner', species: 'wolf', stage: 'Elder', level: 30, rarity: 'Legendary', breed_count: 0 },
      { id: 'fresh-uncommon', species: 'fox', stage: 'Adult', level: 3, rarity: 'Uncommon', breed_count: 1 },
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };
  ok(await bot.handleVaultIntake(state) === true, 'handleVaultIntake reports success');
  const moves = client.calls.filter(c => c.path === '/api/storage/move');
  ok(moves.length === 1 && moves[0].body.itemId === 'fresh-uncommon' && moves[0].body.store === true,
    `moves the fresh Uncommon INTO the vault, not the strongest runner (${JSON.stringify(moves[0]?.body)})`);
  ok(ledger.some(e => e.type === 'creature_vault' && e.meta?.reason === 'breeding-intake'),
    `records creature_vault with reason breeding-intake (${JSON.stringify(ledger)})`);
}

// --- 10g) VAULT INTAKE: pool already at target size → no-op (does not overfill the breeding pool) ---
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't10g', autoBreedingPipeline: true, vaultBreedingPoolTarget: 1, autoEvolve: false, afkZone: false, feed: false });
  const state = {
    player: { gold: 999999 },
    creatures: [
      { id: 'already-in-pool', species: 'fox', stage: 'Adult', level: 3, rarity: 'Uncommon', breed_count: 1, stored: true },
      { id: 'another-fresh-uncommon', species: 'owl', stage: 'Adult', level: 3, rarity: 'Uncommon', breed_count: 0 },
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };
  ok(await bot.handleVaultIntake(state) === false, 'pool already at target(1) → no intake');
  ok(!client.calls.some(c => c.path === '/api/storage/move'), 'no storage/move call when pool is full');
}

// --- 10h) VAULT GRADUATE end-to-end 2026-07-06 — an exhausted (8/8) vaulted breeder is pulled back
//     out so the normal sell path can pick it up next tick.
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't10h', autoBreedingPipeline: true, autoEvolve: false, afkZone: false, feed: false });
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  const state = {
    player: { gold: 999999 },
    creatures: [
      { id: 'still-breeding', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', breed_count: 3, stored: true },
      { id: 'exhausted', species: 'owl', stage: 'Adult', level: 8, rarity: 'Rare', breed_count: 8, stored: true },
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };
  ok(await bot.handleVaultGraduate(state) === true, 'handleVaultGraduate reports success');
  const moves = client.calls.filter(c => c.path === '/api/storage/move');
  ok(moves.length === 1 && moves[0].body.itemId === 'exhausted' && moves[0].body.store === false,
    `un-vaults only the exhausted (8/8) creature, not the still-breeding one (${JSON.stringify(moves[0]?.body)})`);
  ok(ledger.some(e => e.type === 'creature_unvault' && e.meta?.reason === 'bred-exhausted'),
    `records creature_unvault with reason bred-exhausted (${JSON.stringify(ledger)})`);
}

// --- 10i) BREEDING PIPELINE: off by default (opt-in) ---
{
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, { name: 't10i', autoEvolve: false, afkZone: false, feed: false }); // autoBreedingPipeline not set → default false
  const state = {
    player: { gold: 999999 },
    creatures: [
      { id: 'fresh-uncommon', species: 'fox', stage: 'Adult', level: 3, rarity: 'Uncommon', breed_count: 1 },
      { id: 'exhausted', species: 'owl', stage: 'Adult', level: 8, rarity: 'Rare', breed_count: 8, stored: true },
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };
  ok(await bot.handleVaultIntake(state) === false, 'intake disabled by default');
  ok(await bot.handleVaultGraduate(state) === false, 'graduate disabled by default');
  ok(!client.calls.some(c => c.path === '/api/storage/move'), 'no storage/move calls when pipeline is off');
}

// --- 10j) REGRESSION 2026-07-06 (owner: "яйца не двигаются" — main stuck at 50/50, 0 stored, despite
//     pickBreedingIntake finding a valid candidate on real data): vaultIntake/vaultGraduate/vaultSwap
//     used to run in preDungeonActions, BEFORE claim — so a creature still carrying last-tick's run_id
//     always looked "busy", and intake could never find a free candidate on an account whose whole
//     roster stays perpetually dispatched. Moved into handleDungeons, AFTER the post-claim reload
//     (same fix pattern as recycle/vault). This test proves the fix through the REAL call chain: a
//     creature that is BUSY at tick-start but gets freed by claim-this-tick IS seen as intake-eligible
//     in the SAME tick — which would be impossible if intake still read the stale pre-claim state.
{
  const now = Date.now();
  const client = mockClient((path) => {
    if (path === '/api/dungeon/claim') return { dungeonRewards: { gold: 100 } };
    if (path === '/api/player/load') {
      // post-claim reality: c1's run_id is gone (claimed), roster otherwise unchanged
      return {
        player: { gold: 999999 },
        creatures: [{ id: 'c1', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', breed_count: 2 }],
        eggs: [], dungeonRuns: [], materials: [],
      };
    }
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't10j', autoBreedingPipeline: true, autoRecycleCreatures: false, autoVaultWhenFull: false,
    autoEvolve: false, afkZone: false, feed: false,
  });
  const state = {
    player: { gold: 999999 },
    creatures: [{ id: 'c1', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', breed_count: 2, run_id: 'r1' }],
    eggs: [], dungeonRuns: [{ id: 'r1', status: 'active', ready_at: new Date(now - 1000).toISOString(), party: ['c1'] }],
    materials: [],
  };
  await bot.handleDungeons(state);
  const moves = client.calls.filter(c => c.path === '/api/storage/move');
  ok(moves.length === 1 && moves[0].body.itemId === 'c1' && moves[0].body.store === true,
    `intake sees c1 as free using the POST-claim state, not the stale pre-claim run_id (${JSON.stringify(moves)})`);
}

// --- 11) breed: no same-species pair available -> no call ---
{
  const client = mockClient(() => ({ bredSuccess: true }));
  const bot = new ZenkoBot(client, { name: 't11', autoEvolve: false, afkZone: false, feed: false });
  const state = {
    player: { gold: 999999 },
    creatures: [{ id: 'b1', species: 'fox', stage: 'Adult', level: 5 }, { id: 'b2', species: 'owl', stage: 'Adult', level: 5 }],
    eggs: [], dungeonRuns: [], materials: [],
  };
  await bot.handleBreed(state);
  ok(!client.calls.some(c => c.path === '/api/breed'), 'skips breed when no species has 2+ eligible creatures');
}

// --- 11b) incubator-pressure gate 2026-07-05: breeding eggs monopolize the shared (bought+bred)
//     incubator for 30min-4h vs seconds/minutes for bought eggs — found live: main had ALL 6/6
//     incubator slots + a 17-deep queue that was 100% breeding-type, bought eggs couldn't get in at
//     all. Fix: pause NEW breeds once pendingBreedingEggs >= breedMaxPendingEggs, so the queue drains.
{
  const breedableCreatures = [
    { id: 'a1', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', happiness: 100 },
    { id: 'a2', species: 'fox', stage: 'Adult', level: 8, rarity: 'Uncommon', happiness: 100 },
  ];
  // at the cap (3 pending breeding eggs, default breedMaxPendingEggs) → skip, even with gold + a valid pair
  {
    const client = mockClient(() => ({ bredSuccess: true }));
    const bot = new ZenkoBot(client, { name: 't11b-atcap', autoEvolve: false, afkZone: false, feed: false });
    const state = {
      player: { gold: 999999 },
      creatures: breedableCreatures,
      eggs: [
        { id: 'e1', egg_type: 'breeding', status: 'inventory' },
        { id: 'e2', egg_type: 'breeding', status: 'incubating' },
        { id: 'e3', egg_type: 'breeding', status: 'ready' },
      ],
      dungeonRuns: [], materials: [],
    };
    await bot.handleBreed(state);
    ok(!client.calls.some(c => c.path === '/api/breed'), 'skips breed when pendingBreedingEggs already at breedMaxPendingEggs(3)');
  }
  // below the cap (2 pending) → breed proceeds
  {
    const client = mockClient(() => ({ bredSuccess: true }));
    const bot = new ZenkoBot(client, { name: 't11b-below', autoEvolve: false, afkZone: false, feed: false });
    const state = {
      player: { gold: 999999 },
      creatures: breedableCreatures,
      eggs: [
        { id: 'e1', egg_type: 'breeding', status: 'inventory' },
        { id: 'e2', egg_type: 'breeding', status: 'incubating' },
      ],
      dungeonRuns: [], materials: [],
    };
    await bot.handleBreed(state);
    ok(client.calls.some(c => c.path === '/api/breed'), 'breeds when pendingBreedingEggs (2) is below the cap');
  }
  // bought (non-breeding) eggs and already-hatched breeding eggs must NOT count toward the cap
  {
    const client = mockClient(() => ({ bredSuccess: true }));
    const bot = new ZenkoBot(client, { name: 't11b-noncounting', autoEvolve: false, afkZone: false, feed: false });
    const state = {
      player: { gold: 999999 },
      creatures: breedableCreatures,
      eggs: [
        { id: 'e1', egg_type: 'forest', status: 'inventory' },
        { id: 'e2', egg_type: 'forest', status: 'incubating' },
        { id: 'e3', egg_type: 'breeding', status: 'hatched' },
        { id: 'e4', egg_type: 'breeding', status: 'hatched' },
        { id: 'e5', egg_type: 'breeding', status: 'hatched' },
      ],
      dungeonRuns: [], materials: [],
    };
    await bot.handleBreed(state);
    ok(client.calls.some(c => c.path === '/api/breed'), 'bought eggs and hatched breeding eggs are excluded from the pressure count');
  }
  // breedMaxPendingEggs:Infinity (opt-out) → gate never blocks regardless of queue depth
  {
    const client = mockClient(() => ({ bredSuccess: true }));
    const bot = new ZenkoBot(client, { name: 't11b-optout', autoEvolve: false, afkZone: false, feed: false, breedMaxPendingEggs: Infinity });
    const state = {
      player: { gold: 999999 },
      creatures: breedableCreatures,
      eggs: Array.from({ length: 20 }, (_, i) => ({ id: 'e' + i, egg_type: 'breeding', status: 'incubating' })),
      dungeonRuns: [], materials: [],
    };
    await bot.handleBreed(state);
    ok(client.calls.some(c => c.path === '/api/breed'), 'breedMaxPendingEggs:Infinity disables the gate entirely');
  }
}

// --- 12) rewards: also attempts epoch/claim (distinct from forbidden epoch/donate) and records gems ---
{
  const client = mockClient((path) => { if (path === '/api/epoch/claim') return { gems: 1 }; return {}; });
  const bot = new ZenkoBot(client, { name: 't12', autoEvolve: false, afkZone: false, feed: false, autoBreed: false });
  const state = { player: { gold: 0, quest_claims: {} }, creatures: [], eggs: [], dungeonRuns: [], materials: [] };
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });

  await bot.handleRewards(state);
  ok(client.calls.some(c => c.path === '/api/epoch/claim'), 'attempts epoch/claim');
  ok(ledger.some(e => e.type === 'epoch_claim' && e.amounts?.gems === 1),
    `records epoch claim gems (${JSON.stringify(ledger)})`);
}

// --- 13) marketplace liquidation: lists one safe junk relic at the live floor, never buyer endpoints ---
{
  const client = mockClient((path, body) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?kind=gold') return { listings: [] };
    if (path === '/api/market/browse?kind=relic') {
      return { listings: [{ id: 'floor-r', item_kind: 'relic', quantity: 1, price_usd: 0.101, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: `listed-${body.itemId}` };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't13',
    autoSellGold: true,
    autoSellJunk: true,
    autoSellJunkRelics: true,
    autoSellJunkCreatures: false,
    depthCeiling: 25,
    cashoutGoldReserve: 1_000_000,
    cashoutMinPriceUsd: 0.01,
    cashoutPriceJitterMin: 1,
    cashoutPriceJitterMax: 1,
    ledger: false,
  });
  const state = {
    player: { gold: 10_000 },
    creatures: [],
    eggs: [],
    dungeonRuns: [],
    materials: [],
    relics: [
      { id: 'r1', rarity: 'Common', stat: 'Attack', value: 4 },
      { id: 'r2', rarity: 'Common', stat: 'Attack', value: 3 },
      { id: 'r3', rarity: 'Common', stat: 'Attack', value: 2 },
      { id: 'r4', rarity: 'Common', stat: 'Attack', value: 1, equipped_on: 'c1' },
      { id: 'r5', rarity: 'Rare', stat: 'Attack', value: 10 },
    ],
  };

  await bot.handleCashout(state);

  const list = client.calls.find(c => c.path === '/api/market/list');
  ok(list?.body?.itemKind === 'relic' && list?.body?.itemId === 'r3' && list?.body?.priceUsd === 0.11,
    `lists one safe junk relic at floor cents (${JSON.stringify(list?.body)})`);
  ok(!client.calls.some(c => /\/api\/market\/(quote|buy|buy-gems)/.test(c.path)),
    `does not touch buyer endpoints (${client.calls.map(c => c.path).join(',')})`);
}

// --- 14) cashout gate: a fresh bot without restored ceiling must not sell as if it already reached d25 ---
{
  const client = mockClient((path) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'g1', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: 'bad-early-listing' };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't14',
    autoSellGold: true,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    ledger: false,
  });

  await bot.handleCashout({
    player: { gold: 500_000 },
    creatures: [],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  });

  ok(!client.calls.some(c => c.path === '/api/market/list'),
    `fresh bot does not cash out before reaching target/plateau (${client.calls.map(c => c.path).join(',')})`);
}

// --- 15) cashout gate: do not stack more Gold listings after active listing cap ---
{
  const client = mockClient((path) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?mine=1&kind=gold') {
      return { listings: [
        { id: 'g-active-1', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko', status: 'active' },
        { id: 'g-active-2', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' },
        { id: 'g-active-3', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko', status: 'listed' },
      ] };
    }
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: 'bad-stacked-listing' };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't15',
    autoSellGold: true,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    cashoutMaxActiveListings: 3,
    ledger: false,
  });

  await bot.handleCashout({
    player: { gold: 500_000 },
    creatures: [],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  });

  ok(client.calls.some(c => c.path === '/api/market/browse?mine=1&kind=gold'),
    `checks own active Gold listings (${client.calls.map(c => c.path).join(',')})`);
  ok(!client.calls.some(c => c.path === '/api/market/list'),
    `does not stack Gold listing past cap (${client.calls.map(c => c.path).join(',')})`);
}

// --- 16) autoSellJunk alone must not list Gold ---
{
  const client = mockClient((path) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: 'bad-gold-listing' };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't16',
    autoSellGold: false,
    autoSellJunk: true,
    autoSellJunkRelics: false,
    autoSellJunkCreatures: false,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    ledger: false,
  });

  await bot.handleCashout({
    player: { gold: 500_000 },
    creatures: [],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  });

  ok(!client.calls.some(c => c.path === '/api/market/browse?kind=gold'),
    `junk-only cashout does not read Gold floor (${client.calls.map(c => c.path).join(',')})`);
  ok(!client.calls.some(c => c.path === '/api/market/list'),
    `junk-only cashout does not list Gold (${client.calls.map(c => c.path).join(',')})`);
}

// --- 17) weighted cashout lane: creature roll lists a creature before Gold ---
{
  const client = mockClient((path, body) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?mine=1&kind=creature') return { listings: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'g-floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: `listed-${body.itemId || 'gold'}` };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't17',
    autoSellGold: true,
    autoSellJunk: true,
    autoSellJunkRelics: false,
    autoSellJunkCreatures: true,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    cashoutGoldWeight: 1,
    cashoutCreatureWeight: 3,
    cashoutMaxActiveCreatureListings: 9,
    rng: () => 0.9,
    ledger: false,
  });
  // Rarity-aware creature pricing (2026-07-05) reads bot.creatureFloorZolana/priceUsd, NOT
  // market/browse?kind=creature (that endpoint is rarity-blind — see creatureFloorUsdForRarity).
  bot.creatureFloorZolana = { common: 100 };
  bot.priceUsd = 0.002; // floorUsd = 100 × 0.002 = $0.20

  await bot.handleCashout({
    player: { gold: 500_000 },
    creatures: [
      { id: 'c1', species: 'fox', rarity: 'Common', variant: 'normal', stage: 'Baby', level: 3 },
      { id: 'c2', species: 'fox', rarity: 'Common', variant: 'normal', stage: 'Baby', level: 2 },
      { id: 'c3', species: 'fox', rarity: 'Common', variant: 'normal', stage: 'Baby', level: 1 },
    ],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  });

  const list = client.calls.find(c => c.path === '/api/market/list');
  ok(list?.body?.itemKind === 'creature',
    `creature-weighted cashout lists creature first (${JSON.stringify(list?.body)})`);
  ok(!client.calls.some(c => c.path === '/api/market/browse?kind=gold'),
    `creature success does not read Gold floor (${client.calls.map(c => c.path).join(',')})`);
  ok(!client.calls.some(c => c.path === '/api/market/browse?kind=creature'),
    `creature pricing is rarity-aware — never reads the rarity-blind browse endpoint (${client.calls.map(c => c.path).join(',')})`);
}

// --- 17b) creature cashout falls back to owner seed price when live per-rarity floor is missing
//     (thin market — Rare trades rarely, recent-sales window is often empty for it; 2026-07-05) ---
{
  const client = mockClient((path, body) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?mine=1&kind=creature') return { listings: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'g-floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: `listed-${body.itemId || 'gold'}` };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't17b',
    autoSellGold: true,
    autoSellJunk: true,
    autoSellJunkRelics: false,
    autoSellJunkCreatures: true,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    cashoutGoldWeight: 1,
    cashoutCreatureWeight: 3,
    cashoutMaxActiveCreatureListings: 9,
    junkCreatureRarities: ['uncommon', 'rare'], // farm-profile shape: bot default is ['common'] only
    junkCreatureStages: ['Baby', 'Juvenile', 'Adult', 'Elder'],
    junkCreatureKeepPerSpecies: 0, // default keeps 2 per species — fixture below has only 1 wolf
    rng: () => 0.9,
    ledger: false,
  });
  bot.creatureFloorZolana = {}; // no live sales at all for this rarity — thin market
  bot.priceUsd = 0.03;          // live token price — irrelevant here since there's no ZOLANA floor to convert

  await bot.handleCashout({
    player: { gold: 500_000 },
    creatures: [
      { id: 'c1', species: 'wolf', rarity: 'Rare', variant: 'normal', stage: 'Adult', level: 10 },
    ],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  });

  const list = client.calls.find(c => c.path === '/api/market/list');
  ok(list?.body?.itemKind === 'creature' && list?.body?.priceUsd === CREATURE_FLOOR_SEED_USD.rare,
    `no live Rare floor → lists at owner seed $${CREATURE_FLOOR_SEED_USD.rare} (${JSON.stringify(list?.body)})`);
}

// --- 17c) VARIANT/RARITY SELL OVERRIDE end-to-end 2026-07-06 (owner: "анкамон рейнбоу... в сейф, и по
//     0.2, на рынок") — an exhausted Uncommon Rainbow is eligible for sale (unlike a normal-variant
//     Golden of the same rarity, which stays excluded) and lists at the $0.2 variant override price,
//     NOT the plain $0.03 Uncommon seed — through the real pickJunkCreatures→listJunkItem chain. ---
{
  const client = mockClient((path, body) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?mine=1&kind=creature') return { listings: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'g-floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: `listed-${body.itemId || 'gold'}` };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't17c',
    autoSellGold: true,
    autoSellJunk: true,
    autoSellJunkRelics: false,
    autoSellJunkCreatures: true,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    cashoutGoldWeight: 1,
    cashoutCreatureWeight: 3,
    cashoutMaxActiveCreatureListings: 9,
    junkCreatureRarities: ['uncommon', 'rare'],
    junkCreatureStages: ['Baby', 'Juvenile', 'Adult', 'Elder'],
    junkCreatureKeepPerSpecies: 0,
    junkMinBreedCount: 8,
    junkVariantRarityOverrides: ['uncommon:rainbow'],
    rng: () => 0.9,
    ledger: false,
  });
  bot.creatureFloorZolana = { uncommon: 1000 }; // a live Uncommon floor DOES exist — override must still win over it
  bot.priceUsd = 0.0001; // live uncommon floorUsd would be 1000×0.0001 = $0.10 if the override didn't apply

  await bot.handleCashout({
    player: { gold: 500_000 },
    creatures: [
      { id: 'golden-exhausted', species: 'fox', rarity: 'Uncommon', variant: 'Golden', stage: 'Adult', level: 10, breed_count: 8 }, // exhausted, NOT overridden → must stay unsold
      { id: 'rainbow-exhausted', species: 'owl', rarity: 'Uncommon', variant: 'Rainbow', stage: 'Adult', level: 10, breed_count: 8 }, // exhausted, overridden → sellable
    ],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  });

  const list = client.calls.find(c => c.path === '/api/market/list');
  ok(list?.body?.itemId === 'rainbow-exhausted', `picks the Rainbow (overridden), not the Golden (not overridden) (${JSON.stringify(list?.body)})`);
  ok(list?.body?.priceUsd === CREATURE_VARIANT_PRICE_OVERRIDE_USD['uncommon:rainbow'],
    `lists at the $${CREATURE_VARIANT_PRICE_OVERRIDE_USD['uncommon:rainbow']} variant override, not the live $0.10 uncommon floor (${JSON.stringify(list?.body)})`);
}

// --- 18) weighted cashout lane: Gold roll lists Gold before creatures ---
{
  const rolls = [0, 0.5, 0.5, 0.5, 0.5];
  const rng = () => rolls.length ? rolls.shift() : 0.5;
  const client = mockClient((path, body) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?mine=1&kind=gold') return { listings: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'g-floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/browse?kind=creature') {
      return { listings: [{ id: 'c-floor', item_kind: 'creature', quantity: 1, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: `listed-${body.itemId || 'gold'}` };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't18',
    autoSellGold: true,
    autoSellJunk: true,
    autoSellJunkRelics: false,
    autoSellJunkCreatures: true,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    cashoutGoldWeight: 1,
    cashoutCreatureWeight: 3,
    rng,
    ledger: false,
  });

  await bot.handleCashout({
    player: { gold: 500_000 },
    creatures: [
      { id: 'c1', species: 'fox', rarity: 'Common', variant: 'normal', stage: 'Baby', level: 3 },
      { id: 'c2', species: 'fox', rarity: 'Common', variant: 'normal', stage: 'Baby', level: 2 },
      { id: 'c3', species: 'fox', rarity: 'Common', variant: 'normal', stage: 'Baby', level: 1 },
    ],
    eggs: [],
    dungeonRuns: [],
    materials: [],
  });

  const list = client.calls.find(c => c.path === '/api/market/list');
  ok(list?.body?.itemKind === 'gold',
    `gold-weighted cashout lists Gold first (${JSON.stringify(list?.body)})`);
}

// --- 18b) GOLD SELL HYSTERESIS 2026-07-06 (owner: "когда накапливается 1.5М пусть сливает 1М,
//     постепенно, по 100к" — found while investigating why gold had NEVER sold once all session).
//     A plain reserve-subtraction gate (surplus=gold-reserve>=minLot) would start selling as soon as
//     gold crosses reserve+minLot, and re-trigger on every small uptick thereafter — NOT what was
//     asked. cashoutGoldSellTrigger adds an arm/disarm state machine on top: must reach the trigger
//     before selling STARTS, and won't restart after a sell-down until it climbs ALL THE WAY back up
//     to the trigger again (not just back above reserve+minLot). ---
{
  const client = mockClient((path, body) => {
    if (path === '/api/market/browse?mine=1&kind=gold') return { listings: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: `listed-${body.itemId || 'gold'}` };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't18b',
    autoSellGold: true,
    cashoutGoldReserve: 500_000,
    cashoutGoldSellTrigger: 1_500_000,
    cashoutMinLotGold: 100_000,
    cashoutMinPriceUsd: 0.01,
    cashoutChunkFracMin: 1, cashoutChunkFracMax: 1, // deterministic: always list the FULL surplus, no jitter
    cashoutPriceJitterMin: 1, cashoutPriceJitterMax: 1,
    rng: () => 0.5,
    ledger: false,
  });

  // 1) Below trigger (1,000,000 < 1,500,000) — surplus (500,000) would clear reserve+minLot on its
  //    own, but must NOT sell without first reaching the trigger.
  ok(await bot.tryListGold({ player: { gold: 1_000_000 } }) === false,
    'gold below trigger never lists, even though plain surplus math would allow it');
  ok(!client.calls.some(c => c.path === '/api/market/list'), 'no listing call made below trigger');

  // 2) At the trigger — arms and lists. planGoldListing nudges the exact quantity off a round number
  //    (human-like, see marketplace.js) so assert "close to and never exceeding the full surplus"
  //    rather than exact equality — the rounding tweak itself isn't what this test is about.
  ok(await bot.tryListGold({ player: { gold: 1_500_000 } }) === true, 'gold at trigger arms and lists');
  let listCall = client.calls.filter(c => c.path === '/api/market/list').at(-1);
  ok(listCall?.body?.quantity <= 1_000_000 && listCall?.body?.quantity > 999_000,
    `lists ~the full 1,000,000 surplus (1.5M - 500k reserve) (got ${listCall?.body?.quantity})`);

  // 3) Now armed, gold sits just above reserve+minLot but below the ORIGINAL trigger — plain
  //    reserve math would allow another sale here; the armed-until-drained state should still allow
  //    it (armed stays true until surplus drains below minLot, matching "sell gradually" not "one shot").
  ok(await bot.tryListGold({ player: { gold: 650_000 } }) === true,
    'still armed after the first sale — continues draining toward reserve without needing to re-hit 1.5M');
  listCall = client.calls.filter(c => c.path === '/api/market/list').at(-1);
  ok(listCall?.body?.quantity <= 150_000 && listCall?.body?.quantity > 149_000,
    `lists ~the remaining 150,000 surplus (650k - 500k reserve) (got ${listCall?.body?.quantity})`);

  // 4) Surplus now exhausted (gold back at reserve) — disarms.
  ok(await bot.tryListGold({ player: { gold: 550_000 } }) === false, 'surplus below minLot → no sale, and disarms');

  // 5) Disarmed: gold ticks back up into "surplus > minLot" territory again but stays UNDER the
  //    trigger — must NOT resume selling (this is the actual bug fix — old reserve-only logic would
  //    have sold again right here).
  ok(await bot.tryListGold({ player: { gold: 700_000 } }) === false,
    'disarmed and below trigger → does not resume selling just because surplus cleared minLot again');

  // 6) Climbs all the way back to the trigger — re-arms and sells again.
  ok(await bot.tryListGold({ player: { gold: 1_500_000 } }) === true, 're-accumulating to the trigger re-arms selling');
}

// --- 18c) GOLD SELL HYSTERESIS: disabled by default (cashoutGoldSellTrigger unset) — old immediate
//     reserve+minLot behavior is preserved for backward compatibility. ---
{
  const client = mockClient((path, body) => {
    if (path === '/api/market/browse?mine=1&kind=gold') return { listings: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: `listed-${body.itemId || 'gold'}` };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't18c',
    autoSellGold: true,
    cashoutGoldReserve: 500_000,
    // cashoutGoldSellTrigger intentionally NOT set — must behave exactly as before this change
    cashoutMinLotGold: 100_000,
    cashoutMinPriceUsd: 0.01,
    cashoutChunkFracMin: 1, cashoutChunkFracMax: 1,
    cashoutPriceJitterMin: 1, cashoutPriceJitterMax: 1,
    rng: () => 0.5,
    ledger: false,
  });
  ok(await bot.tryListGold({ player: { gold: 650_000 } }) === true,
    'without a trigger configured, selling starts as soon as surplus clears reserve+minLot, same as pre-2026-07-06');
}

// --- 19) market reconcile: active live listing missing from ledger is synced as pending ---
{
  const client = mockClient((path) => {
    if (path === '/api/market/browse?mine=1') {
      return { listings: [{ id: 'live-open', item_kind: 'creature', item_id: 'c9', price_usd: 0.3, currency: 'zenko', status: 'active' }] };
    }
    return {};
  });
  const bot = new ZenkoBot(client, { name: 't19', ledger: false });
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  bot.loadLedgerEvents = () => [];

  await bot.syncActiveMarketListings(Date.parse('2026-07-04T12:00:00Z'));

  ok(ledger.length === 1 && ledger[0].type === 'market_sync' && ledger[0].ref.listingId === 'live-open',
    `syncs active listing into ledger (${JSON.stringify(ledger)})`);
}

// --- 20) market reprice: stale overpriced listing is cancelled and relisted near floor ---
{
  const client = mockClient((path, body) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?mine=1') {
      return { listings: [{ id: 'old-gold', item_kind: 'gold', quantity: 100000, price_usd: 0.5, currency: 'zenko', status: 'active', created_at: '2026-07-03T06:00:00Z' }] };
    }
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/cancel') return { ok: true, listingId: body.listingId };
    if (path === '/api/market/list') return { id: 'new-gold' };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't20',
    autoSellGold: true,
    autoSellJunk: false,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    cashoutRepriceEnabled: true,
    cashoutRepriceMinAgeMs: 4 * 60 * 60 * 1000,
    cashoutRepriceMinDropPct: 0.05,
    ledger: false,
  });
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });

  await bot.handleCashout({ player: { gold: 500_000 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] });

  const cancel = client.calls.find(c => c.path === '/api/market/cancel');
  const list = client.calls.find(c => c.path === '/api/market/list');
  ok(cancel?.body?.listingId === 'old-gold', `cancels stale listing (${JSON.stringify(cancel?.body)})`);
  ok(list?.body?.itemKind === 'gold' && list.body.quantity === 100000 && list.body.priceUsd === 0.2,
    `relists gold at floor (${JSON.stringify(list?.body)})`);
  ok(ledger.some(e => e.type === 'market_cancel') && ledger.some(e => e.type === 'market_list' && e.ref.repriceFrom === 'old-gold'),
    `records reprice ledger events (${JSON.stringify(ledger)})`);
}

// --- 21) market sell gate: do not list below the live marketplace ZOLANA threshold ---
{
  const client = mockClient((path) => {
    if (path === '/api/market/my-sales?limit=100') return { sales: [] };
    if (path === '/api/market/browse?kind=gold') {
      return { listings: [{ id: 'floor', item_kind: 'gold', quantity: 100000, price_usd: 0.2, currency: 'zenko' }] };
    }
    if (path === '/api/market/list') return { id: 'bad-gate-listing' };
    return {};
  });
  const bot = new ZenkoBot(client, {
    name: 't21',
    autoSellGold: true,
    autoSellJunk: false,
    depthCeiling: 25,
    cashoutGoldReserve: 0,
    cashoutMinLotGold: 50_000,
    cashoutMinPriceUsd: 0.01,
    marketSellMinZolana: 10_000,
    ledger: false,
  });

  await bot.handleCashout({ player: { gold: 500_000, zenko_balance: 4_850 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] });

  ok(!client.calls.some(c => c.path === '/api/market/list'),
    `does not list below marketplace sell gate (${client.calls.map(c => c.path).join(',')})`);
}

// --- 22) recycle unplaces a parked common (place-auto bug: placed pets were stuck forever, never
//     recycled) THEN sacrifices it in the same pass — end-to-end fix for the reported "23 eggs stuck /
//     squad full" incident. Server confirms the unplace by dropping plot_x on reload. ---
{
  let reloaded = false;
  const client = mockClient((path, body) => {
    if (path === '/api/creature/place' && body.unplace === true) return {};
    if (path === '/api/player/load') {
      reloaded = true;
      return {
        player: { gold: 0 },
        creatures: [
          { id: 'target', rarity: 'Rare', stage: 'Adult', level: 20 },
          { id: 'parked', rarity: 'Common', stage: 'Adult', level: 3 }, // plot_x gone: server confirms unplace
        ],
        eggs: [], dungeonRuns: [], materials: [],
      };
    }
    if (path === '/api/creature/sacrifice') return {};
    return {};
  });
  const bot = new ZenkoBot(client, { name: 't22', autoRecycleCreatures: true, autoUnplaceFodder: true, ledger: false });
  const ledger = [];
  bot.recordEvent = (type, event) => ledger.push({ type, ...event });
  const state = {
    player: { gold: 0 },
    creatures: [
      { id: 'target', rarity: 'Rare', stage: 'Adult', level: 20 },
      { id: 'parked', rarity: 'Common', stage: 'Adult', level: 3, plot_x: 2 }, // parked on island → was stuck
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };

  const result = await bot.handleRecycle(state);

  ok(client.calls.some(c => c.path === '/api/creature/place' && c.body.creatureId === 'parked' && c.body.unplace === true),
    `unplaces the parked common (${JSON.stringify(client.calls.map(c => c.path))})`);
  ok(reloaded, 'reloads state after unplacing so the freed pet is visible as fodder');
  ok(ledger.some(e => e.type === 'creature_unplace'), `records creature_unplace ledger event (${JSON.stringify(ledger)})`);
  ok(client.calls.some(c => c.path === '/api/creature/sacrifice' && (c.body.fodderIds || []).includes('parked')),
    `sacrifices the now-unplaced common into XP (${JSON.stringify(client.calls.filter(c => c.path === '/api/creature/sacrifice'))})`);
  ok(result === true, 'handleRecycle reports it recycled');
}

// --- 23) vault audit 2026-07-05: a stored (vaulted) creature must never be treated as available —
//     busyIds() must mark it busy, idleRoster() must exclude it (else dispatchRuns could try to send
//     a creature sitting in storage into a dungeon party). Root cause: neither check looked at
//     `stored`, only status/run_id — found while verifying "does Vault actually work end-to-end".
{
  const bot = new ZenkoBot(mockClient(() => ({})), { name: 't23', autoRecycleCreatures: false, ledger: false });
  const state = {
    player: { gold: 0 },
    creatures: [
      { id: 'vaulted', rarity: 'Rare', stage: 'Adult', level: 20, stored: true },
      { id: 'runner', rarity: 'Common', stage: 'Adult', level: 5 },
    ],
    eggs: [], dungeonRuns: [], materials: [],
  };
  const busy = bot.busyIds(state);
  ok(busy.has('vaulted'), 'busyIds() marks a stored:true creature as busy');
  const idle = bot.idleRoster(state);
  ok(!idle.some(c => c.id === 'vaulted'), `idleRoster() excludes the vaulted creature (got ${JSON.stringify(idle.map(c => c.id))})`);
  ok(idle.some(c => c.id === 'runner'), 'idleRoster() still includes the genuinely free creature');
}

// --- 24) breed diagnostic visibility 2026-07-05: found live — 3-4 accounts had an apparent valid
//     same-species pair (visible fields) but zero breeds in 4h, and it was IMPOSSIBLE to tell why
//     (happiness/cooldown aren't in the dashboard snapshot, and 400/402/409 were fully silent — no
//     log, no ledger). handleBreed must now surface a reason for every skip path via breedSkipLog.
{
  // (a) "no eligible pair" now logs WHICH species/reasons, not silence
  {
    const client = mockClient(() => ({ bredSuccess: true }));
    const bot = new ZenkoBot(client, { name: 't24a', autoEvolve: false, afkZone: false, feed: false, ledger: false });
    const state = {
      player: { gold: 999999 },
      creatures: [
        { id: 'c1', species: 'craggle', stage: 'Adult', level: 5, rarity: 'Uncommon', happiness: 20 }, // low happiness
        { id: 'c2', species: 'craggle', stage: 'Adult', level: 5, rarity: 'Uncommon', happiness: 100, last_breed_time: new Date().toISOString() }, // on cooldown
      ],
      eggs: [], dungeonRuns: [], materials: [],
    };
    await bot.handleBreed(state);
    ok(!client.calls.some(c => c.path === '/api/breed'), 'no breed call attempted (both members ineligible)');
    ok(bot.recentLog.some(l => /breed skip:.*uncommon×2.*happiness<50/.test(l)), `logs the low-happiness member (log: ${JSON.stringify(bot.recentLog)})`);
    ok(bot.recentLog.some(l => /breed skip:.*cooldown/.test(l)), 'logs the on-cooldown member');
  }
  // (b) a previously fully-silent 400 API rejection is now surfaced via breedSkipLog
  {
    const client = mockClient(() => { const e = new Error('bad pair'); e.status = 400; e.bodyText = '{"error":"Element mismatch"}'; throw e; });
    const bot = new ZenkoBot(client, { name: 't24b', autoEvolve: false, afkZone: false, feed: false, ledger: false });
    const state = {
      player: { gold: 999999 },
      creatures: [
        { id: 'a1', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', happiness: 100 },
        { id: 'a2', species: 'fox', stage: 'Adult', level: 8, rarity: 'Uncommon', happiness: 100 },
      ],
      eggs: [], dungeonRuns: [], materials: [],
    };
    await bot.handleBreed(state);
    ok(bot.recentLog.some(l => /breed skip: api 400/.test(l)), `a 400 breed rejection is now visible in the log, not fully silent (log: ${JSON.stringify(bot.recentLog)})`);
    ok(!bot.recentLog.some(l => /^breed err/.test(l)), '400/402/409 still does not spam the noisier "breed err" line (that stays for unexpected statuses only)');
  }
  // (c) gold-reserve skip is logged too
  {
    const client = mockClient(() => ({ bredSuccess: true }));
    const bot = new ZenkoBot(client, { name: 't24c', autoEvolve: false, afkZone: false, feed: false, ledger: false, breedGoldReserve: 10000 });
    const state = { player: { gold: 1000 }, creatures: [], eggs: [], dungeonRuns: [], materials: [] };
    await bot.handleBreed(state);
    ok(bot.recentLog.some(l => /breed skip: gold 1000 <= reserve 10000/.test(l)), `gold-reserve skip is diagnosed (log: ${JSON.stringify(bot.recentLog)})`);
  }
}

// --- 25) REAL API SHAPE FOUND 2026-07-06 (owner: "почему мы так медленно генерим петтов") — root
//     cause: /api/player/load returns the ACTIVE roster in `creatures` and vaulted creatures SEPARATELY
//     in `stored.creatures` (confirmed on a raw live dump: every entry in `creatures` has stored:false;
//     entries with stored:true + stored_at + a real breed_count only ever appear in `stored.creatures`).
//     Every existing test above (10b/10c/23/24 etc.) modeled the WRONG shape — a single flat `creatures`
//     array with `stored:true` inlined on one entry — which is why this went unnoticed: that shape
//     coincidentally exercises the same code paths without ever hitting the real split. Against the
//     REAL shape, handleBreed/handleVaultGraduate/handleVaultIntake's poolSize ALL silently no-op on
//     genuinely-stored creatures — the entire "free breeding while vaulted" pipeline bred nothing.
{
  // 25a) handleBreed must select a partner living ONLY in state.stored.creatures (the real shape) —
  // direct proof the core bug is fixed: vault-breeding could not breed anything before this.
  const client = mockClient((path) => { if (path === '/api/breed') return { bredSuccess: true }; return {}; });
  const bot = new ZenkoBot(client, { name: 't25a', autoEvolve: false, afkZone: false, feed: false });
  const state = {
    player: { gold: 999999 },
    creatures: [{ id: 'active', species: 'fox', stage: 'Adult', level: 5, rarity: 'Uncommon', happiness: 100 }],
    stored: { creatures: [{ id: 'vaulted', species: 'fox', stage: 'Elder', level: 40, rarity: 'Uncommon', happiness: 100, stored: true, breed_count: 2 }] },
    eggs: [], dungeonRuns: [], materials: [],
  };
  await bot.handleBreed(state);
  const calls = client.calls.filter(c => c.path === '/api/breed');
  ok(calls.length === 1, `breeds using a partner that lives ONLY in state.stored.creatures (${calls.length} calls, ${JSON.stringify(bot.recentLog)})`);
  const pairIds = new Set([calls[0]?.body?.parentA, calls[0]?.body?.parentB]);
  ok(pairIds.has('vaulted') && pairIds.has('active'), `pair includes the real-shape vaulted parent (${JSON.stringify(calls[0]?.body)})`);
}
{
  // 25b) handleVaultGraduate must find a breed_count>=8 creature living in state.stored.creatures —
  // before this fix, pickBreedingGraduate scanned state.creatures only and could NEVER find it,
  // regardless of breed_count, so exhausted vault-bred creatures would sit in storage forever.
  const client = mockClient((path) => { if (path === '/api/storage/move') return {}; return {}; });
  const bot = new ZenkoBot(client, { name: 't25b', autoBreedingPipeline: true, autoEvolve: false, afkZone: false, feed: false });
  const state = {
    player: { gold: 999999 },
    creatures: [],
    stored: { creatures: [{ id: 'exhausted', species: 'fox', stage: 'Elder', rarity: 'Uncommon', stored: true, breed_count: 8 }] },
    eggs: [], dungeonRuns: [], materials: [],
  };
  const graduated = await bot.handleVaultGraduate(state);
  ok(graduated === true, 'handleVaultGraduate reports success against the real split shape');
  const moves = client.calls.filter(c => c.path === '/api/storage/move');
  ok(moves.length === 1 && moves[0]?.body?.itemId === 'exhausted' && moves[0]?.body?.store === false,
    `un-vaults the exhausted creature found only in state.stored.creatures (${JSON.stringify(moves[0]?.body)})`);
}
{
  // 25c) handleVaultIntake's poolSize must count real state.stored.creatures entries and STOP once at
  // target — before this fix, poolSize always read 0 against the real shape (nothing in state.creatures
  // ever has stored:true), so intake never recognized the pool as full and would drain Adult+ supply
  // from the active roster indefinitely, well past vaultBreedingPoolTarget.
  const client = mockClient((path) => { if (path === '/api/storage/move') return {}; return {}; });
  const bot = new ZenkoBot(client, { name: 't25c', autoBreedingPipeline: true, vaultBreedingPoolTarget: 1, autoEvolve: false, afkZone: false, feed: false });
  const state = {
    player: { gold: 999999 },
    creatures: [{ id: 'candidate', species: 'owl', stage: 'Adult', rarity: 'Uncommon', breed_count: 0 }],
    stored: { creatures: [{ id: 'already-vaulted', species: 'wolf', stage: 'Adult', rarity: 'Uncommon', stored: true, breed_count: 1 }] },
    eggs: [], dungeonRuns: [], materials: [],
  };
  const intaken = await bot.handleVaultIntake(state);
  ok(intaken === false, `pool already AT target (1/1 via the real stored.creatures entry) → does not intake another (got ${intaken})`);
  const moves = client.calls.filter(c => c.path === '/api/storage/move');
  ok(moves.length === 0, `no storage/move call fires once pool target is correctly recognized as met (${JSON.stringify(moves)})`);
}
{
  // 25d) writeLive must report accurate stored:true for a creature living in state.stored.creatures —
  // this is the monitoring counterpart: the dashboard's whole "stored" column existed specifically to
  // verify vault mechanics from telemetry (see test/write-live-stored.test.js) but always read 0
  // against the real API shape, masking the very bug this section fixes.
  const bot = new ZenkoBot({ address: 'MockWa11etAddr2222222222222222222222222222' }, { name: '__test_t25d_write_live__', ledger: false });
  bot.writeLive({
    player: { gold: 1000, zenko_balance: 0 },
    creatures: [{ id: 'active', species: 'nimbu', rarity: 'Common', stage: 'Adult', level: 3 }],
    stored: { creatures: [{ id: 'vaulted', species: 'florix', rarity: 'Rare', stage: 'Adult', level: 9, stored: true, breed_count: 3 }] },
    eggs: [], dungeonRuns: [], materials: [], relics: [],
  });
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'live-__test_t25d_write_live__.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  const byId = Object.fromEntries(written.creaturesList.map(c => [c.id, c]));
  ok(byId.vaulted?.stored === true, `dashboard now correctly shows stored:true for a real stored.creatures entry (${JSON.stringify(byId.vaulted)})`);
  ok(byId.active?.stored === false, 'active creature still correctly shows stored:false');
  if (existsSync(file)) unlinkSync(file);
}

// --- 26) EPIC ADDED TO VAULT-BREEDING 2026-07-06 (owner: "надо чтоб епик тоже бридились") — before
//     this, Epic could only breed if it happened to stay on the active roster and find a same-species
//     partner there (competing with dungeon duty); now it gets the same free-vault treatment as
//     Uncommon/Rare when vaultBreedingRarities explicitly includes 'epic' (farm profile does; this test
//     proves the mechanism, independent of the farm-profile wiring covered in startup-profile.test.js).
{
  const client = mockClient((path) => { if (path === '/api/storage/move') return {}; return {}; });
  const bot = new ZenkoBot(client, {
    name: 't26', autoBreedingPipeline: true, vaultBreedingRarities: ['uncommon', 'rare', 'epic'],
    vaultBreedingPoolTarget: 10, autoEvolve: false, afkZone: false, feed: false,
  });
  const state = {
    player: { gold: 999999 },
    creatures: [{ id: 'epic-candidate', species: 'pyrexis', stage: 'Adult', rarity: 'Epic', breed_count: 0 }],
    stored: { creatures: [] },
    eggs: [], dungeonRuns: [], materials: [],
  };
  const intaken = await bot.handleVaultIntake(state);
  ok(intaken === true, `an Epic Adult+ creature is intake-eligible once vaultBreedingRarities includes 'epic' (got ${intaken})`);
  const moves = client.calls.filter(c => c.path === '/api/storage/move');
  ok(moves.length === 1 && moves[0]?.body?.itemId === 'epic-candidate' && moves[0]?.body?.store === true,
    `vaults the Epic candidate for free breeding, same mechanism as Uncommon/Rare (${JSON.stringify(moves[0]?.body)})`);
}
{
  // 26b) regression guard: WITHOUT 'epic' in vaultBreedingRarities (the pre-change default), the same
  // Epic candidate must NOT be intake-eligible — proves the config change is what's doing the work,
  // not some unrelated side effect.
  const client = mockClient(() => ({}));
  const bot = new ZenkoBot(client, {
    name: 't26b', autoBreedingPipeline: true, vaultBreedingRarities: ['uncommon', 'rare'],
    autoEvolve: false, afkZone: false, feed: false,
  });
  const state = {
    player: { gold: 999999 },
    creatures: [{ id: 'epic-candidate', species: 'pyrexis', stage: 'Adult', rarity: 'Epic', breed_count: 0 }],
    stored: { creatures: [] },
    eggs: [], dungeonRuns: [], materials: [],
  };
  const intaken = await bot.handleVaultIntake(state);
  ok(intaken === false, `without 'epic' explicitly configured, an Epic creature is correctly NOT vaulted (got ${intaken})`);
}

// --- 27) LIVE INCIDENT 2026-07-06 (owner: "в дашборде 18 акков, всм?" — caught a real, currently-
//     ongoing bug via the mismatch between "ledger shows activity" and "dashboard shows stale data"):
//     on accounts where the vault has NEVER been used, the real API returns state.stored.creatures as
//     something OTHER than an array (reproduced: a plain {} throws "is not iterable" when spread).
//     allCreatures() didn't guard against this — writeLive() (tick()'s last, previously-unguarded step)
//     crashed EVERY tick for exactly those accounts, silently freezing their dashboard snapshot for
//     30+ minutes while the real farm (dungeons/feed/ledger, which all run BEFORE writeLive in the same
//     tick) kept working fine underneath — a genuinely confusing "ledger says alive, dashboard says
//     dead" split that only direct evidence (not the dashboard's own "18 live" count) caught.
{
  // 27a) allCreatures must not throw when state.stored.creatures is a non-array (the exact reproduced shape)
  const bot = new ZenkoBot({ address: 'MockWa11etAddr3333333333333333333333333333' }, { name: 't27a', ledger: false });
  const shapes = [
    { creatures: [{ id: 'a' }], stored: { creatures: {} } },
    { creatures: [{ id: 'a' }], stored: { creatures: null } },
    { creatures: [{ id: 'a' }], stored: {} },
    { creatures: [{ id: 'a' }] },
  ];
  let allSafe = true;
  for (const state of shapes) {
    try { bot.allCreatures(state); } catch { allSafe = false; }
  }
  ok(allSafe, 'allCreatures() never throws regardless of state.stored.creatures shape');
  ok(bot.allCreatures({ creatures: [{ id: 'a' }], stored: { creatures: {} } }).length === 1,
    'a non-array stored.creatures is treated as empty (contributes 0), not as a crash');

  // 27b) end-to-end through the real tick() path: writeLive must not silently kill the whole tick when
  // it throws — this is the defense-in-depth half of the fix, independent of the specific shape bug.
  const client = {
    address: 'MockWa11etAddr4444444444444444444444444444', calls: [],
    async login() {}, async api() { return { player: { gold: 0 }, creatures: [], eggs: [], dungeonRuns: [], materials: [], relics: [], stored: { creatures: {} } }; },
  };
  const bot2 = new ZenkoBot(client, { name: 't27b', ledger: false, afkZone: false, feed: false, autoEvolve: false, autoBreed: false });
  let threw = false;
  let result;
  try { result = await bot2.tick(); } catch { threw = true; }
  ok(threw === false, 'tick() completes even against the exact live-reproduced malformed shape');
  ok(result != null, `tick() still returns the live state for the caller to use (got ${JSON.stringify(result)})`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
