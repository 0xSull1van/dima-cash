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

// During a deploy/patch the server replies 503, e.g. { error:"Restarting Server", maintenance:{mode:"full"} }
// or { error:"New Server + Bug Fixes. ETA 20-35 Min." }. So the fleet doesn't hammer a restarting server
// (and doesn't stand out with a burst of retries), on such a reply we "arm" a pause and instantly reject
// subsequent calls — without network — until it ends. The pause ESCALATES across consecutive maintenance
// hits (base → cap) and honours a parsed ETA, so a long patch is waited out with a handful of probes, not
// one every 90s for 35 minutes (found 2026-07-06: an "ETA 20-35 Min" patch had the fleet re-probing ~15×
// per account). The streak resets on the first successful call (server back).
const MAINTENANCE_BASE_MS = 90_000;        // first probe delay when no ETA is given
const MAINTENANCE_CAP_MS = 10 * 60_000;    // escalation ceiling per additional consecutive hit
const MAINTENANCE_MAX_MS = 40 * 60_000;    // hard cap on any single wait (a bogus "ETA 999 Min" can't freeze us)
export function isMaintenanceError(e) {
  if (!e || e.status !== 503) return false;
  // Any 503 during a patch is maintenance; match the patch-style phrasings the game uses so we never
  // treat a "New Server + Bug Fixes. ETA …" reply as a hard error and keep hammering it.
  return /maintenance|restarting server|"code":"maint|new server|bug fixes|be right back|updating|eta\s*[~:]?\s*\d/i.test(String(e.bodyText || e.message || ''));
}

// Parse an ETA (minutes) from a maintenance message → the LOW end in ms, or null. "ETA 20-35 Min" → 20m;
// "be right back in ~15 minutes" → 15m. We wait the low end so the first probe lands around when it MIGHT
// be back, then escalation takes over if it's running late. A single parsed ETA is capped at 60m for sanity.
export function parseMaintenanceEtaMs(text) {
  const s = String(text || '');
  let m = /eta[^\d]{0,6}(\d{1,3})/i.exec(s);                       // "ETA 20-35 Min" → 20
  if (!m) m = /(\d{1,3})\s*(?:-\s*\d{1,3}\s*)?(?:min|minute)/i.exec(s); // "15 minutes"
  const mins = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(mins) || mins <= 0) return null;
  return Math.min(mins, 60) * 60_000;
}

// The next-probe delay for a maintenance hit: max(parsed ETA low-end, escalating base), capped.
// streak is 1 on the first consecutive hit, 2 on the next, … → 90s, 3m, 6m, 10m, 10m… (base×2^(streak-1)).
export function maintenanceWaitMs(streak, etaMs) {
  const escalating = Math.min(MAINTENANCE_BASE_MS * 2 ** Math.max(0, streak - 1), MAINTENANCE_CAP_MS);
  return Math.min(Math.max(etaMs || 0, escalating), MAINTENANCE_MAX_MS);
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
    this.maintenanceStreak = 0; // consecutive maintenance hits → escalating backoff (see maintenanceWaitMs)
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
      const r = await this.#raw(path, { method, body });
      this.maintenanceStreak = 0; // a successful call = server is back; next patch starts fresh at base backoff
      return r;
    } catch (e) {
      if (e.status === 401) {
        this.token = null;
        await this.login();
        const r = await this.#raw(path, { method, body });
        this.maintenanceStreak = 0;
        return r;
      }
      if (isMaintenanceError(e)) {
        this.maintenanceStreak = (this.maintenanceStreak || 0) + 1;
        const waitMs = maintenanceWaitMs(this.maintenanceStreak, parseMaintenanceEtaMs(e.bodyText || e.message));
        this.maintenanceUntil = Date.now() + waitMs;
        e.maintenance = true;
        e.maintenanceWaitMs = waitMs; // surfaced so the bot can log "waiting ~Nm" instead of a bare error
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
