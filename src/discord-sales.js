// Parse the Zenko Marketplace Discord "X sold" posts + build per-trait market medians for pricing.
// Calibrated 2026-07-07 against the REAL channel format:
//   embed.title   = "{Variant?} {Species} sold"   (e.g. "Shadow Darkspecter sold", "Zephyrion sold")
//   field[Price]  = "**569 $ZOLANA** ($0.10)"       (both — we take the USD in the parens)
//   field[Rarity] = "Rare" | "Epic" | "Legendary" | …
//   field[Element]= "Aqua" | …                       (CREATURES have it; relics/items don't → skipped)
//   field[Seller]/[Buyer] = wallet
// Pure + tested so re-calibration is a one-file change.

const RARITY_KEYS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
const VARIANTS = ['rainbow', 'shadow', 'golden', 'shiny']; // special traits; a missing prefix ⇒ normal
const lower = (s) => String(s ?? '').trim().toLowerCase();

// Parse one Discord message → { rarity, variant, species, priceUsd, element } | null (null = not a creature sale).
export function parseSaleMessage(m) {
  const e = (m?.embeds || [])[0];
  const title = e?.title;
  if (!title) return null;
  const sold = /^(.*?)\s+sold$/i.exec(title);
  if (!sold) return null;
  const fields = {};
  for (const f of (e.fields || [])) fields[lower(f.name)] = f.value;
  if (!fields.element) return null;                          // no Element ⇒ relic/item, not a creature — skip
  const rarity = lower(fields.rarity);
  if (!RARITY_KEYS.includes(rarity)) return null;
  const priceStr = String(fields.price || '');
  const pm = /\(\$([\d,]+(?:\.\d+)?)\)/.exec(priceStr);           // "($0.10)" USD
  const priceUsd = pm ? Number(pm[1].replace(/,/g, '')) : null;
  if (!(priceUsd > 0)) return null;
  const zm = /([\d,]+(?:\.\d+)?)\s*\$?zolana/i.exec(priceStr);     // "569 $ZOLANA" — the native amount (dashboard scatter)
  const priceZol = zm ? Number(zm[1].replace(/,/g, '')) : null;
  // variant = leading title word if it's a known trait; the rest (minus it) is the species
  let name = sold[1].trim();
  let variant = 'normal';
  const vm = /^(\S+)\s+(.+)$/.exec(name);
  if (vm && VARIANTS.includes(lower(vm[1]))) { variant = lower(vm[1]); name = vm[2]; }
  return { rarity, variant, species: lower(name), priceUsd, priceZol, element: lower(fields.element) };
}

const median = (arr) => { const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Build per-trait MEDIAN USD from parsed sales, at three granularities so the farm can match most-specific-first:
//   "rarity:variant:species"  (finest), "rarity:variant", and "rarity" (NORMAL-variant baseline for that rarity).
// Returns { medianUsd: {key→usd}, counts: {key→n} }. Special-variant sales feed only their variant/species keys,
// NOT the plain-rarity baseline (a Shadow Epic must not drag the normal-Epic median up).
export function discordTraitMedians(sales = []) {
  const buckets = {};
  const add = (key, usd) => { (buckets[key] = buckets[key] || []).push(usd); };
  for (const s of sales) {
    if (!s || !s.rarity || !(s.priceUsd > 0)) continue;
    const v = s.variant || 'normal';
    if (v === 'normal') add(s.rarity, s.priceUsd);           // plain-rarity baseline = normal only
    else add(`${s.rarity}:${v}`, s.priceUsd);
    if (s.species) add(`${s.rarity}:${v}:${s.species}`, s.priceUsd);
  }
  const medianUsd = {}, floorUsd = {}, counts = {};
  for (const [k, arr] of Object.entries(buckets)) { medianUsd[k] = median(arr); floorUsd[k] = Math.min(...arr); counts[k] = arr.length; }
  return { medianUsd, floorUsd, counts }; // median → pricing; floor (min) → the dashboard "floor" panel
}

// Look up the best (most specific) Discord median for a creature, given the medianUsd map from discordTraitMedians.
// species+variant → variant → (normal only) rarity. Returns { usd, key } | null.
export function discordMedianFor({ rarity, variant, species }, medianUsd = {}, { minCount = 1, counts = {} } = {}) {
  const r = lower(rarity), v = lower(variant) || 'normal', sp = lower(species);
  const keys = v === 'normal'
    ? [sp && `${r}:normal:${sp}`, `${r}`]                     // normal: species-normal, else the rarity baseline
    : [sp && `${r}:${v}:${sp}`, `${r}:${v}`];                 // special: species-variant, else the variant
  for (const k of keys) {
    if (k && medianUsd[k] > 0 && (counts[k] || 1) >= minCount) return { usd: medianUsd[k], key: k };
  }
  return null;
}
