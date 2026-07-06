// ZenkoClient — headless client for the play.zolana.gg game API.
// Auth reproduces the client-side SIWS flow (see the reverse-engineering in NOTES.md):
//   GET  /api/auth/nonce           -> {nonce, expiresAt}
//   sign "Zenko — sign in\n..."     (ed25519, base58)
//   POST /api/auth/login {wallet,issuedAt,nonce,signature} -> {token, expiresAt}
//   every action: header x-zenko-session: <token>
import { ProxyAgent } from 'undici';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { normalizeProxyUrl } from './accounts.js';

const BASE = 'https://play.zolana.gg';
const DOMAIN = 'zolana.gg'; // constant from the bundle (not location.host)
const SIGN_TAIL = '\nSigning once authorizes this device to act for 8h. No funds move.';

// During a deploy/patch the server replies 503 { error:"Restarting Server", maintenance:{mode:"full"}, code:"MAINT..." }.
// So the fleet doesn't hammer a restarting server (and doesn't stand out with a burst of retries), on the
// first such reply we "arm" a short pause and instantly reject subsequent calls, without network, until it ends.
const MAINTENANCE_BACKOFF_MS = 90_000;
export function isMaintenanceError(e) {
  if (!e || e.status !== 503) return false;
  return /maintenance|restarting server|"code":"maint/i.test(String(e.bodyText || e.message || ''));
}

// Default request timeout. Without it a hung/dropped proxy hangs the await FOREVER: fetch neither
// throws nor resolves → runForever()'s try/catch never fires (nothing to throw) → "tick error" isn't
// logged → sleep() until the next tick is never reached → the account dies silently until a manual
// restart of the WHOLE process. Found 2026-07-05: 6/18 accounts hung for 5-13 min without a single log
// line (stale live-*.json snapshot, the log just cuts off). 30s is comfortably above normal latency
// (observed calls finish in seconds) but not infinity.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class ZenkoClient {
  constructor(wallet, {
    base = BASE,
    fetchImpl = globalThis.fetch,
    proxyUrl = null,
    proxyAgentFactory = (url) => new ProxyAgent(url),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    sessionPath = null, // 2026-07-06: path to persist {token,expiresAt} to disk — see #restoreSession
  } = {}) {
    this.wallet = wallet;
    this.base = base;
    this.fetch = fetchImpl;
    this.proxyUrl = normalizeProxyUrl(proxyUrl);
    this.dispatcher = this.proxyUrl ? proxyAgentFactory(this.proxyUrl) : null;
    this.token = null;
    this.expiresAt = 0;
    this.maintenanceUntil = 0; // until this time the server is treated as under maintenance — calls rejected immediately
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessionPath = sessionPath;
    this.#restoreSession();
  }

  get address() { return this.wallet.address; }

  // The token lives 8h and isn't tied to any particular process (bearer; the server doesn't track a
  // "device" beyond the text of the signed message) — but it used to live only in-memory on the client
  // instance, so EVERY process restart (including the `node --watch` auto-restart on a code edit,
  // 2026-07-06) unconditionally called login() again for all accounts at once. A real login, from the
  // SERVER's and the anti-detection point of view, is the same thing whatever the restart cause was.
  // Persisting to disk BY account NAME removes needless re-logins: a code restart ⇒ the process comes
  // back up, but the token survives the restart ⇒ a real /api/auth/login happens RARELY, only when the
  // token truly expired (~every 8h), like a real player — not every time a file is edited on disk. The
  // format is the same pattern already used for pendingStaminaRestore in bot.js (logs/<kind>-<name>.json).
  #restoreSession() {
    if (!this.sessionPath) return;
    try {
      const raw = JSON.parse(readFileSync(this.sessionPath, 'utf8'));
      if (raw && typeof raw.token === 'string' && Number(raw.expiresAt) > Date.now() + 60_000) {
        this.token = raw.token;
        this.expiresAt = Number(raw.expiresAt);
      }
    } catch { /* no file / corrupt JSON / first run — just log in again below */ }
  }

  #persistSession() {
    if (!this.sessionPath) return;
    try { writeFileSync(this.sessionPath, JSON.stringify({ token: this.token, expiresAt: this.expiresAt })); }
    catch { /* best-effort: a failed write just means a re-login on the next restart, not fatal */ }
  }

  #clearPersistedSession() {
    if (!this.sessionPath) return;
    try { unlinkSync(this.sessionPath); } catch { /* file already gone — not a problem */ }
  }

  async #raw(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.token) headers['x-zenko-session'] = this.token;
    const controller = new AbortController();
    const init = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal, // best-effort: lets a signal-aware dispatcher actually tear down the socket
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;

    // Explicit Promise.race on top of the signal: we don't rely on EVERY path (plain/proxy-dispatcher)
    // wiring abort honestly to reading the response BODY (not just to connect itself) — we guarantee the
    // timeout ourselves. One timer/deadline for the whole request (fetch + body read), not 30s per phase.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const err = new Error(`${method} ${path} -> timeout after ${this.requestTimeoutMs}ms (network/proxy hang, no response)`);
        err.status = 0; // not a real HTTP code: won't match any existing [].includes(e.status) in bot.js
        err.timeout = true;
        reject(err);
      }, this.requestTimeoutMs);
    });

    let res, text;
    try {
      res = await Promise.race([this.fetch(this.base + path, init), timeout]);
      text = await Promise.race([res.text(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      err.bodyText = text;
      throw err;
    }
    return json;
  }

  // Build the exact message to sign (line order is critical).
  #buildMessage(issuedAt, nonce) {
    return [
      'Zenko — sign in',
      `domain: ${DOMAIN}`,
      `wallet: ${this.wallet.address}`,
      `issuedAt: ${issuedAt}`,
      `nonce: ${nonce}`,
      SIGN_TAIL, // starts with \n -> a blank line before the sentence
    ].join('\n');
  }

  async login() {
    const { nonce } = await this.#raw('/api/auth/nonce', { auth: false });
    const issuedAt = Date.now();
    const message = this.#buildMessage(issuedAt, nonce);
    const signature = this.wallet.signMessage(new TextEncoder().encode(message));
    const out = await this.#raw('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { wallet: this.wallet.address, issuedAt, nonce, signature },
    });
    this.token = out.token;
    this.expiresAt = out.expiresAt;
    this.#persistSession();
    return out;
  }

  async ensureAuth() {
    if (!this.token || this.expiresAt <= Date.now() + 60_000) await this.login();
    return this.token;
  }

  // Generic game-action call. On 401 (session killed/expired) — re-login and one retry.
  // On 503-maintenance — arm a pause and until it ends reject calls locally, without touching the server.
  async api(path, body) {
    if (Date.now() < this.maintenanceUntil) {
      const err = new Error(`${path} -> skipped: server maintenance`);
      err.status = 503; err.maintenance = true;
      throw err;
    }
    const method = body === undefined ? 'GET' : 'POST';
    try {
      await this.ensureAuth();
      return await this.#raw(path, { method, body });
    } catch (e) {
      if (e.status === 401) {
        this.token = null;
        await this.login();
        return this.#raw(path, { method, body });
      }
      if (isMaintenanceError(e)) {
        this.maintenanceUntil = Date.now() + MAINTENANCE_BACKOFF_MS;
        e.maintenance = true;
      }
      throw e;
    }
  }

  logout() {
    this.#clearPersistedSession(); // don't let the next restart pick up an already-revoked token
    if (!this.token) return Promise.resolve();
    const p = this.#raw('/api/auth/logout', { method: 'POST' }).catch(() => {});
    this.token = null;
    this.expiresAt = 0;
    return p;
  }
}
