import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePlayer, isZolanaGateError } from '../src/player-bootstrap.js';

test('ensurePlayer creates missing player with account name and grants starter egg', async () => {
  const calls = [];
  const client = {
    api: async (path, body) => {
      calls.push({ path, body });
      if (path === '/api/player/load' && calls.filter(call => call.path === path).length === 1) {
        const err = new Error('missing');
        err.status = 404;
        throw err;
      }
      return { ok: true };
    },
  };

  await ensurePlayer(client, 'Raven');

  assert.deepEqual(calls, [
    { path: '/api/player/load', body: undefined },
    { path: '/api/player/create', body: { username: 'Raven' } },
    { path: '/api/egg/grant-starter', body: {} },
    { path: '/api/player/load', body: undefined },
  ]);
});

test('ensurePlayer does not create when player already exists', async () => {
  const calls = [];
  const client = {
    api: async (path, body) => {
      calls.push({ path, body });
      return { player: { username: 'Raven' } };
    },
  };

  await ensurePlayer(client, 'Raven');

  assert.deepEqual(calls, [
    { path: '/api/player/load', body: undefined },
  ]);
});

test('detects ZOLANA gate errors from player creation', () => {
  const error = new Error('POST /api/player/create -> 403 {"error":"Hold at least 1 $ZOLANA to play"}');
  error.status = 403;
  error.bodyText = '{"error":"Hold at least 1 $ZOLANA to play — you currently hold 0."}';

  assert.equal(isZolanaGateError(error), true);
  assert.equal(isZolanaGateError(Object.assign(new Error('forbidden'), { status: 403, bodyText: '{"error":"other"}' })), false);
});
