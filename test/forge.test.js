import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTrainerForge } from '../src/bot.js';

const cfg = { forgeMinGold: 400000, forgeDailyCap: 2, forgeTrainerSlots: ['amulet', 'ring', 'idol'], forgeRelicClass: 'trainer', forgeGoldCost: 250000 };

test('planTrainerForge: gates on forgeMinGold (protects egg/breed budget)', () => {
  assert.equal(planTrainerForge(cfg, { gold: 399999, forgesToday: 0 }), null, 'below min gold → no forge');
  assert.ok(planTrainerForge(cfg, { gold: 400000, forgesToday: 0 }), 'at min gold → forge');
});

test('planTrainerForge: respects daily cap', () => {
  assert.ok(planTrainerForge(cfg, { gold: 999999, forgesToday: 1 }), 'under cap → forge');
  assert.equal(planTrainerForge(cfg, { gold: 999999, forgesToday: 2 }), null, 'at cap → no forge');
});

test('planTrainerForge: rotates slots amulet→ring→idol by forges-today', () => {
  assert.equal(planTrainerForge(cfg, { gold: 999999, forgesToday: 0 }).slot, 'amulet');
  assert.equal(planTrainerForge(cfg, { gold: 999999, forgesToday: 1 }).slot, 'ring');
  // idol only reachable if cap allows; test rotation math directly with a higher cap
  assert.equal(planTrainerForge({ ...cfg, forgeDailyCap: 3 }, { gold: 999999, forgesToday: 2 }).slot, 'idol');
});

test('planTrainerForge: carries relicClass + cost for the caller', () => {
  const p = planTrainerForge(cfg, { gold: 999999, forgesToday: 0 });
  assert.equal(p.relicClass, 'trainer');
  assert.equal(p.costGold, 250000);
});

test('planTrainerForge: defaults are sane when cfg omitted', () => {
  // no forgeMinGold → 0 floor; default cap 2; default slots
  const p = planTrainerForge({}, { gold: 0, forgesToday: 0 });
  assert.ok(p && p.slot === 'amulet' && p.relicClass === 'trainer');
});
