import { ephemeralWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';

const w = ephemeralWallet();
console.log('ephemeral wallet:', w.address);
const c = new ZenkoClient(w);

try {
  const nonceRes = await fetch('https://play.zolana.gg/api/auth/nonce').then(r => r.json());
  console.log('nonce endpoint OK:', JSON.stringify(nonceRes).slice(0, 140));
} catch (e) { console.log('nonce fetch err:', e.message); }

try {
  const out = await c.login();
  console.log('LOGIN OK -> token len:', (out.token || '').length, 'expiresAt:', out.expiresAt);
  // Try loading a player (likely needs a created player, but shows the gate)
  try {
    const p = await c.api('/api/player/load');
    console.log('player/load OK:', JSON.stringify(p).slice(0, 200));
  } catch (e) { console.log('player/load ->', e.status, (e.bodyText || '').slice(0, 160)); }
} catch (e) {
  console.log('LOGIN result:', e.status, '-', (e.bodyText || e.message).slice(0, 220));
}
