// Parse a Discord "item sold" message into { rarity, variant, species, priceUsd }.
// Used by scripts/discord-floor-tracker.js. The official project channel posts every sale; the exact layout
// (embed fields vs plain text, where rarity/price live) differs per sale-bot, so this is a BEST-EFFORT scan
// over the WHOLE message text. ⚠️ CALIBRATE against a real sample (owner to paste one) — especially the
// species extraction — then tighten the field parsing below. Pure + tested so calibration is a one-file change.

const RARITIES = ['mythical', 'legendary', 'epic', 'rare', 'uncommon', 'common']; // highest first (regex order)
const VARIANTS = ['rainbow', 'shadow', 'golden', 'shiny'];                         // special traits; absence ⇒ normal
const NON_SPECIES = new Set([...RARITIES, ...VARIANTS, 'sold', 'item', 'price', 'buyer', 'seller', 'market', 'creature', 'pet', 'zolana', 'zol', 'for', 'the', 'new']);

// Flatten a Discord message (content + every embed title/description/author/field/footer) into one text blob.
export function messageText(m) {
  const parts = [m?.content || ''];
  for (const e of (m?.embeds || [])) {
    parts.push(e.title || '', e.description || '', e.author?.name || '');
    for (const f of (e.fields || [])) parts.push(`${f.name || ''}: ${f.value || ''}`);
    if (e.footer?.text) parts.push(e.footer.text);
  }
  return parts.join('\n');
}

// USD price from text. Handles "$0.12", "0.12 USD", and "120 ZOLANA"/"120 $ZOL" (× the live token price).
// Prefers an explicit USD figure; falls back to a $ZOLANA amount only if zolanaPriceUsd is known.
export function parsePriceUsd(text, { zolanaPriceUsd = 0 } = {}) {
  const s = String(text || '');
  const usd = s.match(/\$\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*usd\b/i);
  if (usd) return Number((usd[1] || usd[2]).replace(/,/g, ''));
  const zol = s.match(/([\d,]+(?:\.\d+)?)\s*\$?zol(?:ana)?\b/i);
  if (zol && zolanaPriceUsd > 0) return Number(zol[1].replace(/,/g, '')) * zolanaPriceUsd;
  return null;
}

// Parse one message → { rarity, variant, species, priceUsd } | null (null if it isn't a recognizable sale).
export function parseSaleMessage(m, { zolanaPriceUsd = Number(process.env.ZOLANA_PRICE_USD) || 0 } = {}) {
  const text = messageText(m);
  if (!text.trim()) return null;
  const low = text.toLowerCase();
  const rarity = RARITIES.find((r) => new RegExp(`\\b${r}\\b`).test(low)) || null;
  const variant = VARIANTS.find((v) => new RegExp(`\\b${v}\\b`).test(low)) || 'normal';
  const priceUsd = parsePriceUsd(text, { zolanaPriceUsd });
  if (!rarity || !(priceUsd > 0)) return null;
  // species: best-effort — the first Capitalized word that isn't a rarity/variant/keyword (usually the pet name).
  const species = (text.match(/\b([A-Z][a-z]{2,})\b/g) || [])
    .map((w) => w.toLowerCase())
    .find((w) => !NON_SPECIES.has(w)) || null;
  return { rarity, variant, species, priceUsd };
}
