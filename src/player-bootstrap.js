export function isZolanaGateError(error) {
  if (error?.status !== 403) return false;
  const text = `${error.message || ''}\n${error.bodyText || ''}`;
  return /hold at least 1\s+\$zolana/i.test(text);
}

export async function ensurePlayer(client, username, { log = () => {} } = {}) {
  try {
    const state = await client.api('/api/player/load');
    log('player exists');
    return state;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  log(`creating player "${username}"`);
  try {
    await client.api('/api/player/create', { username });
  } catch (error) {
    if (error.status !== 409) throw error;
  }

  try {
    await client.api('/api/egg/grant-starter', {});
    log('starter egg granted');
  } catch {
    // Already granted or endpoint unavailable; player creation itself succeeded.
  }

  return client.api('/api/player/load');
}
