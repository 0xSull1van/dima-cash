import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

// 2026-07-06 (friend's strategy): evolution stops at Adult for common..epic (Elder just wastes Gold and
// Adult is the breeding stage); only Legendary/Mythical may be leveled to Elder as premier dungeon runners.
function makeBot(overrides = {}) {
  const calls = [];
  const bot = new ZenkoBot({
    address: 'Evo11111111111111111111111111111111111',
    wallet: {},
    api: async () => ({}),
  }, {
    name: 'evo',
    ledger: false,
    persistStaminaPending: false,
    minGoldReserve: 0,
    ...overrides,
  });
  bot.act = async (path, body) => { calls.push({ path, body }); return {}; };
  return { bot, calls };
}

const evolvedIds = (calls) => calls.filter(c => c.path === '/api/creature/evolve').map(c => c.body.creatureId);

test('evolveElderRarities caps Adult→Elder to top-tier rarities; younger stages always evolve', async () => {
  const { bot, calls } = makeBot({ evolveElderRarities: ['legendary', 'mythical'] });
  await bot.handleEvolve({
    player: { gold: 1_000_000 },
    creatures: [
      { id: 'adult-unc', stage: 'Adult', rarity: 'Uncommon', creature_xp: 999 },   // capped → NOT evolved to Elder
      { id: 'adult-epic', stage: 'Adult', rarity: 'Epic', creature_xp: 999 },       // capped → NOT evolved to Elder
      { id: 'adult-leg', stage: 'Adult', rarity: 'Legendary', creature_xp: 999 },   // allowed → evolves to Elder
      { id: 'juv-rare', stage: 'Juvenile', rarity: 'Rare', creature_xp: 999 },      // below Adult → always evolves
      { id: 'baby-com', stage: 'Baby', rarity: 'Common', creature_xp: 999 },        // below Adult → always evolves
    ],
  });
  const ids = evolvedIds(calls);
  assert.ok(ids.includes('baby-com'), 'Baby always evolves toward Adult');
  assert.ok(ids.includes('juv-rare'), 'Juvenile always evolves toward Adult');
  assert.ok(ids.includes('adult-leg'), 'Adult Legendary may evolve to Elder');
  assert.ok(!ids.includes('adult-unc'), 'Adult Uncommon is capped at Adult (no Elder)');
  assert.ok(!ids.includes('adult-epic'), 'Adult Epic is capped at Adult (no Elder)');
});

test('evolveElderRarities null = every rarity may reach Elder (old default behavior)', async () => {
  const { bot, calls } = makeBot({ evolveElderRarities: null });
  await bot.handleEvolve({
    player: { gold: 1_000_000 },
    creatures: [
      { id: 'adult-unc', stage: 'Adult', rarity: 'Uncommon', creature_xp: 999 },
    ],
  });
  assert.ok(evolvedIds(calls).includes('adult-unc'), 'no cap configured → Adult evolves to Elder');
});
