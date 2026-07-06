import { ephemeralWallet } from '../src/wallet.js';
import { ZenkoClient } from '../src/client.js';

const c = new ZenkoClient(ephemeralWallet());
await c.login();
console.log('auth OK as', c.address, '\n');

async function tryGet(path) {
  try { const r = await c.api(path); console.log('GET ', path, '->', JSON.stringify(r).slice(0, 260)); }
  catch (e) { console.log('GET ', path, '->', e.status, (e.bodyText || '').slice(0, 160)); }
}
async function tryPost(path, body) {
  try { const r = await c.api(path, body); console.log('POST', path, JSON.stringify(body), '->', JSON.stringify(r).slice(0, 260)); }
  catch (e) { console.log('POST', path, JSON.stringify(body), '->', e.status, (e.bodyText || '').slice(0, 200)); }
}

await tryGet('/api/servers');
await tryGet('/api/price');
await tryGet('/api/store/state');
await tryPost('/api/player/create', { name: 'botmain' });
await tryPost('/api/player/create', { name: 'botmain', server: 1 });
await tryGet('/api/player/load');
await tryPost('/api/egg/grant-starter', {});
await tryPost('/api/dungeon/start', { dungeon: 1 });

await c.logout();
console.log('\ndone');
