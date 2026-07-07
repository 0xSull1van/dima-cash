import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSaleMessage, parsePriceUsd, messageText } from '../src/discord-sales.js';

// NOTE: these fixtures are PLAUSIBLE sale-post shapes — recalibrate against a real message from the channel.
test('parseSaleMessage: embed with fields (rarity/variant/price)', () => {
  const m = { timestamp: '2026-07-07T00:00:00Z', embeds: [{ title: 'Item Sold', fields: [
    { name: 'Creature', value: 'Shadow Smoldra' },
    { name: 'Rarity', value: 'Uncommon' },
    { name: 'Price', value: '$0.12' },
    { name: 'Buyer', value: 'someone' },
  ] }] };
  const r = parseSaleMessage(m);
  assert.equal(r.rarity, 'uncommon');
  assert.equal(r.variant, 'shadow');
  assert.equal(r.priceUsd, 0.12);
  assert.equal(r.species, 'smoldra');
});

test('parseSaleMessage: plain content, $ZOLANA price × token rate', () => {
  const m = { content: 'SOLD: Rare Thornmaw for 1,200 ZOLANA' };
  const r = parseSaleMessage(m, { zolanaPriceUsd: 0.0002 });
  assert.equal(r.rarity, 'rare');
  assert.equal(r.variant, 'normal');
  assert.ok(Math.abs(r.priceUsd - 0.24) < 1e-9, '1200 × 0.0002 ≈ 0.24');
  assert.equal(r.species, 'thornmaw');
});

test('parsePriceUsd: USD wins over ZOLANA; ZOLANA needs a rate', () => {
  assert.equal(parsePriceUsd('$1.50'), 1.5);
  assert.equal(parsePriceUsd('0.30 USD'), 0.30);
  assert.equal(parsePriceUsd('500 ZOL', { zolanaPriceUsd: 0.0002 }), 0.1);
  assert.equal(parsePriceUsd('500 ZOLANA'), null, 'no rate → cannot convert');
});

test('parseSaleMessage: not a sale (no price / no rarity) → null', () => {
  assert.equal(parseSaleMessage({ content: 'gm everyone' }), null);
  assert.equal(parseSaleMessage({ content: 'Uncommon pet looks cool' }), null, 'rarity but no price');
  assert.equal(parseSaleMessage({ content: 'sold for $0.10' }), null, 'price but no rarity');
});

test('messageText flattens content + embed fields', () => {
  const t = messageText({ content: 'hi', embeds: [{ title: 'T', fields: [{ name: 'A', value: 'B' }] }] });
  assert.match(t, /hi/); assert.match(t, /T/); assert.match(t, /A: B/);
});
