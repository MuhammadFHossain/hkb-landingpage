'use strict';

/**
 * Capstan Funnel server.
 * Zero npm dependencies. Node 18+. See SPEC.md "server.js endpoints" for the contract.
 *
 * Routes:
 *   GET  /            weighted sticky split, serves dist/<variant>/index.html
 *   GET  /thanks      serves dist/<cf_v>/thanks.html (falls back to control)
 *   GET  /shared.css  static from dist/
 *   GET  /assets/*    static from dist/assets/ (traversal-protected)
 *   POST /subscribe   email capture -> data/subscribers.jsonl, 303 to /thanks?n=<pos>
 *   POST /e           event beacon -> data/events.jsonl, 204
 *   POST /survey      thanks-page micro-survey, stored as event "survey", 204
 *   GET  /dash        HTML dashboard (requires ?key=DASH_KEY)
 *   GET  /api/stats   stats JSON (requires ?key=DASH_KEY)
 *   GET  /healthz     200 "ok"
 *   *                 404
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = path.join(ROOT, 'data');
const VARIANTS_DIR = path.join(ROOT, 'variants');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const SUBS_FILE = path.join(DATA_DIR, 'subscribers.jsonl');

const COOKIE_AGE = 180 * 24 * 60 * 60; // 180 days, in seconds

// Whitelisted event names for POST /e (SPEC.md).
const EVENT_NAMES = new Set([
  'pageview', 'scroll_50', 'scroll_90', 'form_start', 'form_submit',
  'ty_pageview', 'deposit_click', 'community_click', 'share_click', 'survey',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// ---------------------------------------------------------------------------
// Settings (settings.json + env overrides)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  productName: 'Capstan',
  companyName: 'HumanKind Bionics',
  contactEmail: 'contact@humankindbionics.com',
  stripeLink: '',
  communityUrl: '',
  webhookUrl: '',
  control: 'capstan-cmt',
  sequentialN: 300,
  priceRetail: 399,
  priceFounding: 349,
  depositAmount: 25,
  firstRunUnits: 500,
};

function loadSettings() {
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8'));
  } catch (err) {
    console.warn('[warn] settings.json not readable (' + err.message + '); using built-in defaults');
  }
  const s = Object.assign({}, DEFAULT_SETTINGS, fromFile);
  // Env vars override file settings.
  if (process.env.WEBHOOK_URL) s.webhookUrl = process.env.WEBHOOK_URL;
  if (process.env.STRIPE_LINK) s.stripeLink = process.env.STRIPE_LINK;
  if (process.env.COMMUNITY_URL) s.communityUrl = process.env.COMMUNITY_URL;
  return s;
}

const settings = loadSettings();
const PORT = parseInt(process.env.PORT, 10) || 4870;
const DASH_KEY = process.env.DASH_KEY || 'letmein';

// TRUST_PROXY: comma-separated IPs of reverse proxies we sit behind.
// Empty (default) means X-Forwarded-For is never trusted.
const TRUST_PROXY = new Set(
  String(process.env.TRUST_PROXY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// COOKIE_SECURE=1 (or true) forces the Secure attribute on every cookie.
const COOKIE_SECURE = /^(1|true)$/i.test(String(process.env.COOKIE_SECURE || ''));

if (!process.env.DASH_KEY) {
  console.warn('!'.repeat(64));
  console.warn('!! WARNING: DASH_KEY is not set. Dashboard key is "letmein".  !!');
  console.warn('!! Anyone who guesses it can read signups and stats.          !!');
  console.warn('!! Set DASH_KEY to a long random string before going live.    !!');
  console.warn('!'.repeat(64));
}

// ---------------------------------------------------------------------------
// Variants (scanned once at startup)
// ---------------------------------------------------------------------------

function loadVariants() {
  let files = [];
  try {
    files = fs.readdirSync(VARIANTS_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.warn('[warn] variants/ directory not readable (' + err.message + ')');
    return [];
  }
  if (files.length === 0) {
    console.warn('[warn] no variant configs found in variants/*.json; GET / will return 503');
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(VARIANTS_DIR, f), 'utf8'));
      if (!cfg || typeof cfg.id !== 'string' || !cfg.id) {
        console.warn('[warn] variants/' + f + ' has no "id"; skipping');
        continue;
      }
      out.push({
        id: cfg.id,
        label: typeof cfg.label === 'string' ? cfg.label : cfg.id,
        status: cfg.status === 'active' ? 'active' : 'paused',
        weight: cfg.weight == null ? 1 : Math.max(0, Number(cfg.weight) || 0),
      });
    } catch (err) {
      console.warn('[warn] could not parse variants/' + f + ': ' + err.message);
    }
  }
  return out;
}

const variants = loadVariants();

function activeVariants() {
  return variants.filter((v) => v.status === 'active');
}

/** Weighted random pick among active variants. */
function pickVariant(active) {
  let total = 0;
  for (const v of active) total += v.weight;
  if (total <= 0) return active[Math.floor(Math.random() * active.length)];
  let r = Math.random() * total;
  for (const v of active) {
    r -= v.weight;
    if (r < 0) return v;
  }
  return active[active.length - 1];
}

// ---------------------------------------------------------------------------
// Data dir
// ---------------------------------------------------------------------------

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error('[error] could not create data/: ' + err.message);
}

/** Append one row as a single JSON line. Always JSON.stringify the whole row. */
function appendJsonl(file, row) {
  const line = JSON.stringify(row) + '\n';
  try {
    fs.appendFileSync(file, line);
  } catch (err) {
    // data/ may have been deleted at runtime; recreate once and retry.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(file, line);
  }
}

/** Tolerant JSONL parse (local copy; used where stats.js may not exist yet). */
function parseJsonlLocal(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object') rows.push(row);
    } catch (_) { /* skip bad line */ }
  }
  return rows;
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Small helpers: sanitize, cookies, responses
// ---------------------------------------------------------------------------

/** Strip control characters (prevents header/JSONL shenanigans in stored strings). */
function stripCtl(s) {
  return String(s).replace(/[\u0000-\u001F\u007F]/g, '');
}

function iso() {
  return new Date().toISOString();
}

/**
 * Sanitize an arbitrary meta value: strings stripped of control chars and
 * length-capped, numbers/booleans/null passed through, shallow objects/arrays
 * allowed to depth 3. Anything else is dropped.
 */
function sanitizeMeta(value, depth) {
  depth = depth || 0;
  if (depth > 3) return undefined;
  if (typeof value === 'string') return stripCtl(value).slice(0, 200);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20)
      .map((v) => sanitizeMeta(v, depth + 1))
      .filter((v) => v !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n >= 20) break;
      const sv = sanitizeMeta(value[k], depth + 1);
      if (sv !== undefined) {
        out[stripCtl(k).slice(0, 64)] = sv;
        n++;
      }
    }
    return out;
  }
  return undefined;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch (_) { /* keep raw */ }
    out[name] = value;
  }
  return out;
}

/** Should cookies carry the Secure attribute for this request? */
function cookieSecure(req) {
  if (COOKIE_SECURE) return true;
  return req && req.headers && req.headers['x-forwarded-proto'] === 'https';
}

/**
 * Append a Set-Cookie header. Not HttpOnly on purpose: the client event
 * snippet reads cf_v/cf_sid; they hold no PII (SPEC.md).
 * Secure is added when COOKIE_SECURE is set or the request came in over
 * https (x-forwarded-proto); plain-http localhost keeps working.
 */
function setCookie(req, res, name, value, maxAgeSec) {
  const cookie = name + '=' + encodeURIComponent(value) +
    '; Max-Age=' + maxAgeSec + '; Path=/; SameSite=Lax' +
    (cookieSecure(req) ? '; Secure' : '');
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', [].concat(prev, cookie));
}

function sendText(res, code, text, extraHeaders) {
  const body = Buffer.from(String(text), 'utf8');
  const headers = Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(body); // Node suppresses the body automatically for HEAD requests
}

function sendHtml(res, code, html, extraHeaders) {
  const body = Buffer.isBuffer(html) ? html : Buffer.from(String(html), 'utf8');
  const headers = Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(body);
}

function redirect303(res, location) {
  res.writeHead(303, { Location: location, 'Content-Length': 0 });
  res.end();
}

function send204(res) {
  res.writeHead(204);
  res.end();
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, fixed one-minute windows per IP)
// ---------------------------------------------------------------------------

const LIMITER_MAX_ENTRIES = 50000; // hard cap on tracked IPs per limiter

function makeLimiter(maxPerMinute) {
  const hits = new Map(); // ip -> { count, reset }

  // At the cap, evict the entry with the oldest reset before inserting.
  function evictOldest() {
    let oldestKey = null;
    let oldestReset = Infinity;
    for (const [key, h] of hits) {
      if (h.reset < oldestReset) {
        oldestReset = h.reset;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) hits.delete(oldestKey);
  }

  return {
    allow(ip) {
      const now = Date.now();
      let h = hits.get(ip);
      if (!h || now >= h.reset) {
        if (!h && hits.size >= LIMITER_MAX_ENTRIES) evictOldest();
        h = { count: 0, reset: now + 60000 };
        hits.set(ip, h);
      }
      h.count++;
      return h.count <= maxPerMinute;
    },
    sweep() {
      const now = Date.now();
      for (const [ip, h] of hits) {
        if (now >= h.reset) hits.delete(ip);
      }
    },
  };
}

const subscribeLimiter = makeLimiter(5);  // 5 POST /subscribe per IP per minute
const eventLimiter = makeLimiter(60);     // 60 POST /e (and /survey) per IP per minute

const sweeper = setInterval(() => {
  subscribeLimiter.sweep();
  eventLimiter.sweep();
}, 60000);
sweeper.unref();

/**
 * Client IP for rate limiting. X-Forwarded-For is only consulted when the
 * socket peer is a proxy listed in TRUST_PROXY. Even then, we take the LAST
 * untrusted hop (the value the trusted proxy appended), never the first
 * token, because the first token is whatever the client chose to send.
 */
function clientIp(req) {
  const sock = req.socket.remoteAddress || 'unknown';
  if (TRUST_PROXY.size === 0 || !TRUST_PROXY.has(sock)) return sock;
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf !== 'string' || xf.length === 0) return sock;
  const hops = xf.split(',')
    .map((s) => stripCtl(s).trim().slice(0, 64))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!TRUST_PROXY.has(hops[i])) return hops[i];
  }
  return sock;
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/** Read the request body with a hard size cap. Rejects with .status = 413 on overflow. */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) {
        done = true;
        chunks.length = 0;
        const err = new Error('body too large');
        err.status = 413;
        reject(err); // caller responds 413 with Connection: close; keep draining
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) { done = true; resolve(Buffer.concat(chunks)); }
    });
    req.on('error', (err) => {
      if (!done) { done = true; reject(err); }
    });
  });
}

/** Respond to a body-read failure. Closes the connection on 413 so unread bytes are dropped. */
function sendBodyError(res, err) {
  const code = err.status || 400;
  return sendText(res, code, code === 413 ? 'Payload too large' : 'Bad request',
    { Connection: 'close' });
}

/** Parse a body that may be form-encoded or JSON (sendBeacon may send text/plain). */
function parseFlexible(buf, contentType) {
  const text = buf.toString('utf8');
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const o = JSON.parse(text);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (_) { return {}; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.assign({}, querystring.parse(text));
  }
  // Unknown content type: try JSON first, then form encoding.
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch (_) { /* fall through */ }
  return Object.assign({}, querystring.parse(text));
}

/** querystring.parse can produce arrays; collapse to the first string. */
function firstString(v) {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Attribution helpers (variant / sid / utm from cookies)
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SID_RE = /^[0-9a-f]{16}$/;

function variantFromCookies(cookies) {
  const v = cookies.cf_v;
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

/** Return the existing cf_sid or create one (random 16 hex) and set the cookie. */
function ensureSid(req, res, cookies) {
  const sid = cookies.cf_sid;
  if (typeof sid === 'string' && SID_RE.test(sid)) return sid;
  const fresh = crypto.randomBytes(8).toString('hex');
  cookies.cf_sid = fresh; // cache so repeat calls in one request reuse it
  setCookie(req, res, 'cf_sid', fresh, COOKIE_AGE);
  return fresh;
}

function utmFromCookies(cookies) {
  if (!cookies.cf_utm) return null;
  try {
    const raw = JSON.parse(cookies.cf_utm);
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const k of ['source', 'medium', 'campaign', 'content']) {
      if (typeof raw[k] === 'string' && raw[k]) out[k] = stripCtl(raw[k]).slice(0, 120);
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (_) {
    return null;
  }
}

/** First-touch UTM capture: only when utm_* params exist and cf_utm is absent. */
function captureFirstTouchUtm(req, res, url, cookies) {
  if (cookies.cf_utm) return;
  const utm = {};
  const map = {
    utm_source: 'source',
    utm_medium: 'medium',
    utm_campaign: 'campaign',
    utm_content: 'content',
  };
  for (const [param, key] of Object.entries(map)) {
    const val = url.searchParams.get(param);
    if (typeof val === 'string' && val) utm[key] = stripCtl(val).slice(0, 120);
  }
  if (Object.keys(utm).length > 0) {
    setCookie(req, res, 'cf_utm', JSON.stringify(utm), COOKIE_AGE);
  }
}

// ---------------------------------------------------------------------------
// Static serving (confined to dist/)
// ---------------------------------------------------------------------------

/**
 * Resolve a request path against dist/ and refuse anything that escapes it.
 * pathname arrives already percent-decoded; encoded traversal became literal
 * ".." by now and is rejected, as are null bytes and backslashes.
 */
function safeDistPath(pathname) {
  if (pathname.includes('\0') || pathname.includes('..') || pathname.includes('\\')) return null;
  const rel = pathname.replace(/^\/+/, '');
  if (!rel) return null;
  const abs = path.resolve(DIST, rel);
  if (abs !== DIST && !abs.startsWith(DIST + path.sep)) return null;
  return abs;
}

async function serveStatic(req, res, pathname) {
  const abs = safeDistPath(pathname);
  if (!abs) return sendText(res, 400, 'Bad request');
  let st;
  try { st = await fs.promises.stat(abs); } catch (_) { return sendText(res, 404, 'Not found'); }
  if (!st.isFile()) return sendText(res, 404, 'Not found');
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs)
    .on('error', () => { try { res.destroy(); } catch (_) { /* noop */ } })
    .pipe(res);
}

/** Read dist/<id>/<file> if the id is a sane slug; null when absent. */
async function readDistHtml(id, file) {
  if (!id || !ID_RE.test(id)) return null;
  try {
    return await fs.promises.readFile(path.join(DIST, id, file));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route: GET /
// ---------------------------------------------------------------------------

async function serveLanding(req, res, url) {
  const cookies = parseCookies(req);
  const active = activeVariants();

  // ?v=<id> forces a variant (QA); any known variant, even paused.
  let chosen = null;
  const forced = url.searchParams.get('v');
  if (forced && ID_RE.test(forced)) {
    chosen = variants.find((v) => v.id === forced) || null;
  }

  if (!chosen) {
    // Sticky: keep the cookie's variant only if it is still active.
    const sticky = cookies.cf_v;
    if (sticky) chosen = active.find((v) => v.id === sticky) || null;
  }
  if (!chosen) {
    if (active.length === 0) {
      return sendText(res, 503, 'No active variants. Add variants/*.json and run: node build.js');
    }
    chosen = pickVariant(active);
  }

  captureFirstTouchUtm(req, res, url, cookies);

  // Serve the built page; fall back to the control's build if this one is missing.
  let id = chosen.id;
  let html = await readDistHtml(id, 'index.html');
  if (html == null && settings.control && settings.control !== id) {
    id = settings.control;
    html = await readDistHtml(id, 'index.html');
  }
  if (html == null) {
    return sendText(res, 404, 'Page not built yet. Run: node build.js');
  }
  setCookie(req, res, 'cf_v', id, COOKIE_AGE); // cookie always matches what we serve
  return sendHtml(res, 200, html);
}

// ---------------------------------------------------------------------------
// Route: GET /thanks
// ---------------------------------------------------------------------------

async function serveThanks(req, res) {
  const cookies = parseCookies(req);
  let html = await readDistHtml(variantFromCookies(cookies), 'thanks.html');
  if (html == null) html = await readDistHtml(settings.control, 'thanks.html'); // fall back to control
  if (html == null) {
    return sendText(res, 404, 'Page not built yet. Run: node build.js');
  }
  return sendHtml(res, 200, html);
}

// ---------------------------------------------------------------------------
// Route: POST /subscribe
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(raw) {
  const s = stripCtl(firstString(raw)).trim().toLowerCase();
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) return null;
  return s;
}

/**
 * In-memory subscriber index: email -> { position, sid }.
 * Loaded ONCE at startup from subscribers.jsonl, updated on every append.
 * No request handler reads the file again.
 */
function loadSubscriberIndex() {
  const index = new Map();
  const rows = parseJsonlLocal(readFileOrEmpty(SUBS_FILE));
  for (const row of rows) {
    if (typeof row.email === 'string' && row.email && !index.has(row.email)) {
      index.set(row.email, {
        position: index.size + 1,
        sid: typeof row.sid === 'string' ? row.sid : '',
      });
    }
  }
  return index;
}

const subscriberIndex = loadSubscriberIndex();

/** Fire-and-forget webhook delivery; 2s timeout; failures logged, never fatal. */
function fireWebhook(record) {
  const url = settings.webhookUrl;
  if (!url) return;
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    }).then((r) => {
      if (!r.ok) console.warn('[webhook] non-2xx response: ' + r.status);
    }).catch((err) => {
      console.warn('[webhook] delivery failed: ' + (err && err.message));
    });
  } catch (err) {
    console.warn('[webhook] delivery failed: ' + (err && err.message));
  }
}

async function handleSubscribe(req, res) {
  const ip = clientIp(req);
  if (!subscribeLimiter.allow(ip)) {
    return sendText(res, 429, 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });
  }

  let body;
  try {
    body = await readBody(req, 8 * 1024); // 8KB cap (SPEC.md security section)
  } catch (err) {
    return sendBodyError(res, err);
  }
  const data = parseFlexible(body, req.headers['content-type']);
  const cookies = parseCookies(req);
  const sid = ensureSid(req, res, cookies);

  // Honeypot first, before any storage read or write. Non-empty hp means a
  // bot. Respond exactly like a success, store nothing.
  const hp = firstString(data.hp).trim();
  if (hp) {
    return redirect303(res, '/thanks?n=' + (subscriberIndex.size + 1));
  }

  const email = normalizeEmail(data.email);
  if (!email) {
    return sendText(res, 400, 'Please enter a valid email address.');
  }

  const existing = subscriberIndex.get(email);
  if (existing) {
    // Already on the list: never write a duplicate row, never re-fire the
    // webhook. Echo the stored position only to the session that signed up.
    // Any other session gets the generic next position, so nobody can probe
    // whether an email is on the list.
    const position = existing.sid && existing.sid === sid
      ? existing.position
      : subscriberIndex.size + 1;
    return redirect303(res, '/thanks?n=' + position);
  }

  const record = {
    t: iso(),
    email,
    v: variantFromCookies(cookies),
    sid,
    utm: utmFromCookies(cookies),
  };
  appendJsonl(SUBS_FILE, record);
  const position = subscriberIndex.size + 1;
  subscriberIndex.set(email, { position, sid });

  fireWebhook(record); // only for newly added emails
  return redirect303(res, '/thanks?n=' + position);
}

// ---------------------------------------------------------------------------
// Routes: POST /e and POST /survey
// ---------------------------------------------------------------------------

function storeEvent(req, res, cookies, name, meta) {
  const sid = ensureSid(req, res, cookies);
  const row = {
    t: iso(),
    e: name,
    v: variantFromCookies(cookies),
    sid,
    utm: utmFromCookies(cookies),
  };
  if (meta !== undefined) {
    const clean = sanitizeMeta(meta);
    // Cap serialized meta at 512 chars; oversized meta is dropped, not truncated.
    if (clean !== undefined && JSON.stringify(clean).length <= 512) row.meta = clean;
  }
  appendJsonl(EVENTS_FILE, row);
}

async function handleEvent(req, res) {
  const ip = clientIp(req);
  if (!eventLimiter.allow(ip)) {
    return sendText(res, 429, 'Too many requests.', { 'Retry-After': '60' });
  }
  let body;
  try {
    body = await readBody(req, 4 * 1024); // 4KB cap
  } catch (err) {
    return sendBodyError(res, err);
  }
  let data = null;
  try { data = JSON.parse(body.toString('utf8') || '{}'); } catch (_) { /* garbage */ }
  const cookies = parseCookies(req);
  ensureSid(req, res, cookies); // always establish a session cookie, even for junk
  if (!data || typeof data !== 'object' || Array.isArray(data)) return send204(res);
  const name = typeof data.e === 'string' ? data.e : '';
  if (!EVENT_NAMES.has(name)) return send204(res); // whitelist: silently drop unknown names
  storeEvent(req, res, cookies, name, data.meta);
  return send204(res);
}

async function handleSurvey(req, res) {
  const ip = clientIp(req);
  if (!eventLimiter.allow(ip)) {
    return sendText(res, 429, 'Too many requests.', { 'Retry-After': '60' });
  }
  let body;
  try {
    body = await readBody(req, 4 * 1024);
  } catch (err) {
    return sendBodyError(res, err);
  }
  const data = parseFlexible(body, req.headers['content-type']);
  const cookies = parseCookies(req);
  const meta = {
    who: stripCtl(firstString(data.who)).slice(0, 64),
    hand: stripCtl(firstString(data.hand)).slice(0, 64),
    hsafsa: stripCtl(firstString(data.hsafsa)).slice(0, 64),
  };
  storeEvent(req, res, cookies, 'survey', meta);
  return send204(res);
}

// ---------------------------------------------------------------------------
// Routes: GET /dash and GET /api/stats
// ---------------------------------------------------------------------------

function dashKeyOk(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  const a = crypto.createHash('sha256').update(key).digest();
  const b = crypto.createHash('sha256').update(DASH_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

async function serveDash(req, res, url, mode) {
  if (!dashKeyOk(url.searchParams.get('key') || '')) {
    return sendText(res, 403, 'Forbidden');
  }

  // stats.js / dash.js are peer modules; load lazily so the funnel itself
  // still runs if the dashboard modules are missing or broken.
  let statsMod;
  try {
    statsMod = require('./stats.js');
  } catch (err) {
    return sendText(res, 500, 'stats.js could not be loaded: ' + err.message);
  }

  const parse = typeof statsMod.parseJsonl === 'function' ? statsMod.parseJsonl : parseJsonlLocal;
  // Read both JSONL files fresh on every request, without blocking the loop.
  const [eventsText, subsText] = await Promise.all([
    fs.promises.readFile(EVENTS_FILE, 'utf8').catch(() => ''),
    fs.promises.readFile(SUBS_FILE, 'utf8').catch(() => ''),
  ]);
  const events = parse(eventsText);
  const subscribers = parse(subsText);

  let stats;
  try {
    stats = statsMod.computeStats(events, subscribers, settings, variants);
  } catch (err) {
    return sendText(res, 500, 'computeStats failed: ' + err.message);
  }

  const noCache = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

  if (mode === 'json') {
    const body = Buffer.from(JSON.stringify(stats), 'utf8');
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
    }, noCache));
    return res.end(body);
  }

  let dashMod;
  try {
    dashMod = require('./dash.js');
  } catch (err) {
    return sendText(res, 500, 'dash.js could not be loaded: ' + err.message);
  }
  let html;
  try {
    html = dashMod.renderDash(stats, settings);
  } catch (err) {
    return sendText(res, 500, 'renderDash failed: ' + err.message);
  }
  return sendHtml(res, 200, html, noCache);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const method = req.method || 'GET';

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return sendText(res, 400, 'Bad request');
  }

  // Reject null bytes anywhere and malformed percent-encoding up front.
  if ((req.url || '').includes('%00')) return sendText(res, 400, 'Bad request');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    return sendText(res, 400, 'Bad request');
  }
  if (pathname.includes('\0')) return sendText(res, 400, 'Bad request');

  if (method === 'GET' || method === 'HEAD') {
    if (pathname === '/') return serveLanding(req, res, url);
    if (pathname === '/thanks') return serveThanks(req, res);
    if (pathname === '/healthz') return sendText(res, 200, 'ok');
    if (pathname === '/shared.css' || pathname.startsWith('/assets/')) {
      return serveStatic(req, res, pathname); // only GET/HEAD reach here
    }
    if (pathname === '/dash') return serveDash(req, res, url, 'html');
    if (pathname === '/api/stats') return serveDash(req, res, url, 'json');
    // Everything else (including SPEC.md, data/, variants/, source files): 404.
    return sendText(res, 404, 'Not found');
  }

  if (method === 'POST') {
    if (pathname === '/subscribe') return handleSubscribe(req, res);
    if (pathname === '/e') return handleEvent(req, res);
    if (pathname === '/survey') return handleSurvey(req, res);
  }

  return sendText(res, 404, 'Not found');
}

// One bad request must never crash the process.
const server = http.createServer((req, res) => {
  res.on('error', () => { /* client went away mid-response */ });
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => {
      console.error('[error] ' + (req.method || '?') + ' ' + (req.url || '?') + ': ' +
        (err && err.stack ? err.stack : err));
      try {
        if (!res.headersSent) sendText(res, 500, 'Internal server error');
        else res.end();
      } catch (_) { /* socket already gone */ }
    });
});

server.on('clientError', (err, socket) => {
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  } catch (_) { /* noop */ }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (require.main === module) {
  server.listen(PORT, () => {
    const active = activeVariants();
    console.log('[capstan-funnel] listening on http://localhost:' + PORT);
    console.log('[capstan-funnel] variants: ' + (variants.length
      ? variants.map((v) => v.id + ' (' + v.status + ', w=' + v.weight + ')').join(', ')
      : 'none'));
    if (variants.length && active.length === 0) {
      console.warn('[warn] no ACTIVE variants; GET / will return 503');
    }
    if (!fs.existsSync(DIST)) {
      console.warn('[warn] dist/ does not exist yet. Run: node build.js');
    }
  });
}

module.exports = { server, handle };
