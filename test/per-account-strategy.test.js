import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZenkoBot } from '../src/bot.js';

test('bot can start from restored per-account dungeon strategy', () => {
  const bot = new ZenkoBot({
    address: 'Strategy1111111111111111111111111111111',
    wallet: {},
    api: async () => ({}),
  }, {
    name: 'strategy-test',
    ledger: false,
    persistStaminaPending: false,
    dungeonId: 3,
    depth: 12,
    depthCeiling: 14,
    efficientDepth: 10,
  });

  assert.equal(bot.depth, 12);
  assert.equal(bot.depthCeiling, 14);
  assert.equal(bot.efficientDepth, 10);
});
