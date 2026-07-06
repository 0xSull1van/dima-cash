import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountJitterProfile,
  seededRandom,
  shuffleWithRng,
} from '../src/jitter.js';

test('createAccountJitterProfile is stable for the same run seed and account', () => {
  const first = createAccountJitterProfile('Raven', { index: 25, runSeed: 'run-a' });
  const second = createAccountJitterProfile('Raven', { index: 25, runSeed: 'run-a' });

  assert.deepEqual(first, second);
});

test('createAccountJitterProfile changes between run seeds', () => {
  const first = createAccountJitterProfile('Raven', { index: 25, runSeed: 'run-a' });
  const second = createAccountJitterProfile('Raven', { index: 25, runSeed: 'run-b' });

  assert.notDeepEqual(first, second);
});

test('createAccountJitterProfile stays inside configured production ranges', () => {
  const profile = createAccountJitterProfile('Raven', { index: 25, runSeed: 'run-a' });

  assert.ok(profile.bootDelayMs >= 0 && profile.bootDelayMs <= 180_000);
  assert.ok(profile.actionDelayMinMs >= 600 && profile.actionDelayMinMs <= 2_500);
  assert.ok(profile.actionDelayMaxMs >= profile.actionDelayMinMs + 800);
  assert.ok(profile.actionDelayMaxMs <= 6_500);
  assert.ok(profile.tickMinSec >= 60 && profile.tickMinSec <= 120);
  assert.ok(profile.tickMaxSec >= profile.tickMinSec + 60);
  assert.ok(profile.tickMaxSec <= 300);
});

test('shuffleWithRng is deterministic without mutating input', () => {
  const items = ['eggs', 'placement', 'relics', 'evolve', 'breed'];
  const shuffled = shuffleWithRng(items, seededRandom('seed-1'));

  assert.deepEqual(items, ['eggs', 'placement', 'relics', 'evolve', 'breed']);
  assert.deepEqual(shuffled, shuffleWithRng(items, seededRandom('seed-1')));
  assert.notDeepEqual(shuffled, items);
});
