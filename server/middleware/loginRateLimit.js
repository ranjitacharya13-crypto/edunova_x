// server/middleware/loginRateLimit.js
//
// Failure-based login rate limiting for POST /api/auth/login.
//
// Why this exists
// ---------------
// Production traffic reaches this Express app through TWO proxies:
//
//   browser -> Cloudflare Worker (_worker.js) -> Render load balancer -> Express
//
// Without `trust proxy` (and without the worker forwarding the real client
// IP), `req.ip` is the Render load-balancer / worker egress IP — i.e. EVERY
// visitor looks like the same client. Any limiter keyed by `req.ip` alone
// then blocks all legitimate users together after a handful of failures.
// That is exactly the "Too many sign-in attempts" production failure.
//
// Strategy (defence in depth, no single point of false blocking)
// ---------------------------------------------------------------
// 1. ACCOUNT bucket (primary): failed attempts per normalized email. This
//    stops credential stuffing against one account even when the attacker
//    rotates IPs, and it can never block a *different* legitimate user.
// 2. IP bucket (secondary): failed attempts per verified client IP. This
//    stops password spraying (many accounts, one source).
// 3. A successful login CLEARS the account bucket, so a legitimate user who
//    mistypes a few times is never punished for earlier typos.
// 4. Lockouts are WINDOW-BASED and temporary (default 15 minutes), never
//    permanent. Legitimate users always recover automatically.
// 5. Unknown emails are counted too, so lockout behaviour is identical for
//    existing and non-existing accounts (no account-enumeration oracle).
//
// Client-IP trust model
// ---------------------
// The Cloudflare Worker forwards the true client IP in `CF-Connecting-IP`
// (sourced from Cloudflare's own header on the incoming request — clients
// cannot spoof it *through the worker*). The backend only trusts that
// header when the request also carries a matching `X-Proxy-Secret`
// (PROXY_SECRET, set on both the worker and this service). Direct-to-Render
// requests without the secret fall back to `req.ip` (Render LB peer), which
// is shared — but the ACCOUNT bucket still protects every account, so no
// legitimate user is blocked by the shared fallback.
//
// Store
// -----
// In-memory Maps. The current topology is a single Render instance, so this
// is correct and requires no extra infrastructure. If the API ever scales
// to multiple instances, swap the two Maps for a shared store (e.g. Redis)
// behind the same `recordFailure` / `recordSuccess` / `isLocked` interface.
//
// Configuration (all optional, read per-request so tests can tune them)
// ---------------------------------------------------------------------
//   LOGIN_MAX_FAILURES_PER_ACCOUNT  default 10
//   LOGIN_MAX_FAILURES_PER_IP       default 50
//   LOGIN_WINDOW_MS                 default 900000 (15 minutes)
const crypto = require("crypto");

const accountFailures = new Map(); // normalizedEmail -> [timestamps]
const ipFailures = new Map(); // clientIp -> [timestamps]

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function config() {
  return {
    maxPerAccount: positiveInt(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 10),
    maxPerIp: positiveInt(process.env.LOGIN_MAX_FAILURES_PER_IP, 50),
    windowMs: positiveInt(process.env.LOGIN_WINDOW_MS, 15 * 60 * 1000),
  };
}

// Resolve the client IP for rate-limiting purposes.
//
// Trust order:
//   1. CF-Connecting-IP, but ONLY when PROXY_SECRET is configured AND the
//      X-Proxy-Secret header matches (proves the request came through the
//      Cloudflare Worker, which sets that header from Cloudflare's own
//      client-IP signal and overwrites any client-supplied value).
//   2. req.ip (Express, with `trust proxy` set for the Render load
//      balancer). Shared across users behind the worker, but safe because
//      the account bucket is the primary limiter.
function getClientIp(req) {
  const secret = String(process.env.PROXY_SECRET || "");
  const forwarded = String(req.headers?.["cf-connecting-ip"] || "").trim();
  if (secret && forwarded) {
    const presented = String(req.headers?.["x-proxy-secret"] || "");
    if (presented && timingSafeEqual(presented, secret)) return forwarded;
  }
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeEmail(req) {
  const raw = req.body?.email;
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase();
}

// Prune timestamps outside the window; returns the live list.
function liveEntries(map, key, windowMs, now) {
  const list = map.get(key) || [];
  const live = list.filter((t) => now - t < windowMs);
  if (live.length === 0) map.delete(key);
  else map.set(key, live);
  return live;
}

function pruneAll(map, windowMs, now) {
  for (const [key, list] of map) {
    const live = list.filter((t) => now - t < windowMs);
    if (live.length === 0) map.delete(key);
    else map.set(key, live);
  }
  // Hard cap so the maps cannot grow without bound under attack.
  if (map.size > 10000) {
    const oldest = [...map.entries()].sort(
      (a, b) => (a[1][0] || 0) - (b[1][0] || 0)
    );
    for (let i = 0; i < map.size - 10000; i += 1) map.delete(oldest[i][0]);
  }
}

function logAuth(event, fields) {
  // Structured, secret-free diagnostics. Never log passwords, tokens,
  // hashes, or full emails — only a short hash of the account identifier.
  console.log(JSON.stringify({ event, ...fields }));
}

function emailHash(email) {
  if (!email) return "none";
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
}

// Returns { locked, retryAfterSeconds, bucket } for the current request.
function checkLocked(req) {
  const { maxPerAccount, maxPerIp, windowMs } = config();
  const now = Date.now();
  const email = normalizeEmail(req);
  const ip = getClientIp(req);

  pruneAll(accountFailures, windowMs, now);
  pruneAll(ipFailures, windowMs, now);

  if (email) {
    const failures = liveEntries(accountFailures, email, windowMs, now);
    if (failures.length >= maxPerAccount) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowMs - (now - failures[0])) / 1000)
      );
      return { locked: true, retryAfterSeconds, bucket: "account" };
    }
  }

  const ipList = liveEntries(ipFailures, ip, windowMs, now);
  if (ipList.length >= maxPerIp) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowMs - (now - ipList[0])) / 1000)
    );
    return { locked: true, retryAfterSeconds, bucket: "ip" };
  }

  return { locked: false, retryAfterSeconds: 0, bucket: null };
}

function recordLoginFailure(req) {
  const { windowMs } = config();
  const now = Date.now();
  const email = normalizeEmail(req);
  const ip = getClientIp(req);
  if (email) {
    const list = liveEntries(accountFailures, email, windowMs, now);
    list.push(now);
    accountFailures.set(email, list);
  }
  const ipList = liveEntries(ipFailures, ip, windowMs, now);
  ipList.push(now);
  ipFailures.set(ip, ipList);
}

function recordLoginSuccess(req) {
  // A successful authentication clears the account's failure history so
  // legitimate users are never locked out for earlier typos. The IP bucket
  // is left to decay naturally (it guards against spraying, not typos).
  const email = normalizeEmail(req);
  if (email) accountFailures.delete(email);
}

// Express middleware: reject with 429 when either bucket is exhausted.
function loginRateLimit(req, res, next) {
  const { locked, retryAfterSeconds, bucket } = checkLocked(req);
  if (!locked) return next();

  const email = normalizeEmail(req);
  logAuth("auth.login.rate_limited", {
    requestId: req.requestId || null,
    bucket,
    emailHash: emailHash(email),
    clientIp: getClientIp(req),
    retryAfterSeconds,
  });

  res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(429).json({
    error: "Too many sign-in attempts. Please wait a moment and try again.",
    retryAfterSeconds,
    requestId: req.requestId || null,
  });
}

// Test hook: clear all rate-limit state.
function _resetStore() {
  accountFailures.clear();
  ipFailures.clear();
}

module.exports = {
  loginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  getClientIp,
  normalizeEmail,
  emailHash,
  _resetStore,
};
