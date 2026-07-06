import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyFetchFor } from '../src/proxy-fetch.js';

test('proxyFetchFor attaches account proxy dispatcher to Jupiter and RPC fetches', async () => {
  const calls = [];
  const dispatcher = { kind: 'proxy-dispatcher' };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true };
  };

  const proxiedFetch = proxyFetchFor('198.37.116.236:6195:user:pass', {
    fetchImpl,
    proxyAgentFactory: (url) => {
      assert.equal(url, 'http://user:pass@198.37.116.236:6195');
      return dispatcher;
    },
  });

  await proxiedFetch('https://api.jup.ag/swap/v1/quote', { headers: { 'x-api-key': 'key' } });

  assert.equal(calls[0].init.dispatcher, dispatcher);
  assert.deepEqual(calls[0].init.headers, { 'x-api-key': 'key' });
});
