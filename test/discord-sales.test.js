import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSaleMessage, discordTraitMedians, discordMedianFor } from '../src/discord-sales.js';

// Fixtures = the REAL Zenko Marketplace embed shape (captured from the channel 2026-07-07).
const sale = (title, rarity, priceUsd, priceZol = 0, element = 'Aqua') => ({
  timestamp: '2026-07-07T00:00:00Z',
  embeds: [{ title: `${title} sold`, fields: [
    { name: 'Price', value: `**${priceZol} $ZOLANA** ($${priceUsd})` },
    { name: 'Rarity', value: rarity },
    ...(element ? [{ name: 'Element', value: element }] : []),
    { name: 'Seller', value: '`aaaa…bbbb`' },
  ] }],
});

test('parseSaleMessage: normal creature — species/rarity/USD from the embed', () => {
  const r = parseSaleMessage(sale('Stormray', 'Rare', '0.10', 569));
  assert.deepEqual({ rarity: r.rarity, variant: r.variant, species: r.species, priceUsd: r.priceUsd }, { rarity: 'rare', variant: 'normal', species: 'stormray', priceUsd: 0.10 });
});

test('parseSaleMessage: variant is the title prefix ("Shadow Darkspecter sold")', () => {
  const r = parseSaleMessage(sale('Shadow Darkspecter', 'Epic', '0.20', 1147, 'Void'));
  assert.equal(r.variant, 'shadow');
  assert.equal(r.species, 'darkspecter');
  assert.equal(r.rarity, 'epic');
  assert.equal(r.priceUsd, 0.20);
});

test('parseSaleMessage: no Element field ⇒ a relic/item, not a creature → null', () => {
  const relic = { embeds: [{ title: "Warlord's Gauntlet sold", fields: [
    { name: 'Price', value: '**569 $ZOLANA** ($0.10)' }, { name: 'Rarity', value: 'Epic' },
  ] }] };
  assert.equal(parseSaleMessage(relic), null);
});

test('parseSaleMessage: not a "… sold" post → null', () => {
  assert.equal(parseSaleMessage({ embeds: [{ title: 'Welcome!', fields: [] }] }), null);
  assert.equal(parseSaleMessage({ content: 'gm' }), null);
});

test('discordTraitMedians: normal feeds the rarity baseline; variants feed variant + species keys', () => {
  const sales = [
    { rarity: 'epic', variant: 'normal', species: 'stormray', priceUsd: 0.10 },
    { rarity: 'epic', variant: 'normal', species: 'zephyrion', priceUsd: 0.12 },
    { rarity: 'epic', variant: 'shadow', species: 'darkspecter', priceUsd: 0.20 },
    { rarity: 'epic', variant: 'golden', species: 'cyclonix', priceUsd: 0.40 },
  ];
  const { medianUsd } = discordTraitMedians(sales);
  assert.equal(medianUsd.epic, 0.11, 'epic normal baseline = median(0.10,0.12) — Shadow/Golden excluded');
  assert.equal(medianUsd['epic:shadow'], 0.20);
  assert.equal(medianUsd['epic:golden:cyclonix'], 0.40);
  assert.equal(medianUsd.epic === undefined, false);
});

test('discordMedianFor: most-specific-first (species:variant → variant → rarity baseline)', () => {
  const medianUsd = { epic: 0.10, 'epic:shadow': 0.20, 'epic:shadow:darkspecter': 0.22 };
  assert.equal(discordMedianFor({ rarity: 'epic', variant: 'shadow', species: 'darkspecter' }, medianUsd).usd, 0.22);
  assert.equal(discordMedianFor({ rarity: 'epic', variant: 'shadow', species: 'other' }, medianUsd).usd, 0.20, 'unknown species → variant median');
  assert.equal(discordMedianFor({ rarity: 'epic', variant: 'normal', species: 'x' }, medianUsd).usd, 0.10, 'normal → rarity baseline');
  assert.equal(discordMedianFor({ rarity: 'rare', variant: 'normal', species: 'x' }, medianUsd), null, 'no data → null');
});
