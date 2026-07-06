import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRelicEquip } from '../src/relic-optimizer.js';

const relic = (id, slot, extra = {}) => ({
  id,
  class: 'combat',
  slot,
  rarity: 'Rare',
  affixes: [{ key: slot, value: 0.2 }],
  equipped_on: null,
  equip_slot: null,
  listed: false,
  stored: false,
  aura_tier: 0,
  enhance_level: 0,
  ...extra,
});

const cr = (id, stage, level) => ({ id, stage, level });

test('does not unequip non-combat / listed / stored relics', () => {
  const cosmeticClass = relic('x1', 'hp_pct', {
    class: 'cosmetic',
    equipped_on: 'c1',
    equip_slot: 'hp_pct',
  });
  const listed = relic('x2', 'hp_pct', {
    listed: true,
    equipped_on: 'c1',
    equip_slot: 'hp_pct',
  });
  const stored = relic('x3', 'hp_pct', {
    stored: true,
    equipped_on: 'c1',
    equip_slot: 'hp_pct',
  });

  const { unequip } = planRelicEquip([cosmeticClass, listed, stored], [cr('c1', 'Adult', 6)]);

  assert.deepEqual(unequip, []);
});
