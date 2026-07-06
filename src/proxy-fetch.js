import { ProxyAgent } from 'undici';
import { normalizeProxyUrl } from './accounts.js';

export function proxyFetchFor(proxyUrl, {
  fetchImpl = globalThis.fetch,
  proxyAgentFactory = (url) => new ProxyAgent(url),
} = {}) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return fetchImpl;

  const dispatcher = proxyAgentFactory(normalized);
  return (url, init = {}) => fetchImpl(url, {
    ...init,
    dispatcher: init.dispatcher || dispatcher,
  });
}
