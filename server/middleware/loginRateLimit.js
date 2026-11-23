// server/middleware/loginRateLimit.js
//
// Production-grade, failure-based login rate limiting for POST /api/auth/login.
//
// Request paths supported
// -----------------------
// 1. Direct browser -> Render Cloudflare Edge -> Render Envoy LB -> Express
//    (default production path via VITE_API_URL / DEFAULT_PROD_API_URL).
//    Render's own Cloudflare edge overwrites CF-Connecting-IP with the real
//    TCP peer IP, and Express `trust proxy = 2` resolves `req.ip` across both
//    Render hops without trusting client-supplied X-Forwarded-For prefixes.
// 2. Browser -> EduNova Cloudflare Worker (_worker.js) -> Render -> Express.
//    When PROXY_SECRET is configured on both the Worker and Render, the Worker
//    forwards the verified visitor IP in X-EduNova-Client-IP (which Render's
//    Cloudflare edge does not overwrite, unlike CF-Connecting-IP) authenticated
//    with X-Proxy-Secret. Without PROXY_SECRET, Cloudflare Workers' shared
//    egress IP (2a06:98c0:3600::103) is recognized as a shared proxy so
//    unrelated visitors behind the Worker never lock each other out.
//
// Multi-tier defence (no single point of false lockout)
// -----------------------------------------------------
// 1. `account_ip` bucket (primary): failed attempts per (identifier + clientIp).
//    Blocks brute-force attacks from a client IP while ensuring an attacker at
//    another IP cannot lock out the legitimate account owner or demo evaluators.
//    Cleared immediately upon successful authentication from that IP.
// 2. `ip` bucket (secondary): failed attempts per verified clientIp across all
//    accounts. Stops password-spraying attacks from a single source.
// 3. `account_global` bucket (tertiary): failed attempts per identifier across
//    distributed IPs. Mitigates distributed credential stuffing against user
//    accounts (the publicly advertised demo student credential is protected per
//    client IP rather than globally so one abusive source cannot brick public
//    demo access for other visitors).
//
// Shared store
// ------------
// Uses MongoDB (`LoginRateLimit` collection with a TTL index on `expiresAt`)
// automatically whenever a live MongoDB connection is active so multiple
// backend instances share rate-limit state and expired lockouts self-clean.
// Seamlessly falls back to a bounded in-memory sliding-window store when
// MongoDB is disconnected or in unit tests.

const crypto = require("crypto");
const net = require("net");
const mongoose = require("mongoose");
const LoginRateLimitModel = require("../models/LoginRateLimit");

const CLOUDFLARE_WORKER_SHARED_IPS = new Set([
  "2a06:98c0:3600::103",
]);
const PUBLIC_DEMO_EMAILS = new Set([
  "student@edunova.demo",
]);
const MEMORY_MAX_KEYS = 10000;

const memoryStore = new Map(); // bucketKey -> [epochMs]
let customSharedAdapter = null; // test hook for multi-instance shared-store tests

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getConfig() {
  return {
    maxPerAccount: positiveInt(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 5),
    maxPerIp: positiveInt(process.env.LOGIN_MAX_FAILURES_PER_IP, 20),
    maxPerAccountGlobal: positiveInt(
      process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT_GLOBAL,
      Math.max(30, positiveInt(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 5) * 3)
    ),
    maxSharedProxy: positiveInt(process.env.LOGIN_MAX_FAILURES_SHARED_PROXY, 250),
    windowMs: positiveInt(process.env.LOGIN_WINDOW_MS, 5 * 60 * 1000),
  };
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeIp(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  // Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
  const v4Mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const candidate = v4Mapped ? v4Mapped[1] : trimmed.toLowerCase();
  return net.isIP(candidate) !== 0 ? candidate : "";
}

function isCloudflareWorkerSharedIp(ip) {
  return CLOUDFLARE_WORKER_SHARED_IPS.has(String(ip || "").toLowerCase());
}

// Resolve verified client IP + provenance metadata.
function resolveClientIdentity(req) {
  const headers = req?.headers || {};
  const secret = String(process.env.PROXY_SECRET || "");

  // 1. Authenticated EduNova Cloudflare Worker proxy: trust X-EduNova-Client-IP
  //    (or non-shared CF-Connecting-IP) ONLY when X-Proxy-Secret matches.
  if (secret) {
    const presented = String(headers["x-proxy-secret"] || "");
    if (presented && timingSafeEqual(presented, secret)) {
      const workerClientIp =
        normalizeIp(headers["x-edunova-client-ip"]) ||
        normalizeIp(headers["cf-connecting-ip"]);
      if (workerClientIp && !isCloudflareWorkerSharedIp(workerClientIp)) {
        return {
          ip: workerClientIp,
          source: "worker-verified",
          isSharedProxy: false,
        };
      }
    }
  }

  // 2. Render managed ingress: Render fronts all *.onrender.com services with
  //    Cloudflare, which overwrites CF-Connecting-IP with the real TCP peer.
  const isRenderRuntime = String(process.env.RENDER || "").toLowerCase() === "true";
  if (isRenderRuntime && headers["cf-ray"]) {
    const cfIp = normalizeIp(headers["cf-connecting-ip"]);
    if (cfIp) {
      if (isCloudflareWorkerSharedIp(cfIp)) {
        return {
          ip: cfIp,
          source: "cloudflare-worker-shared",
          isSharedProxy: true,
        };
      }
      return {
        ip: cfIp,
        source: "render-cloudflare",
        isSharedProxy: false,
      };
    }
  }

  // 3. Express `req.ip` (governed by `app.set("trust proxy", ...)`).
  //    Unauthenticated forwarded headers are never read directly here.
  const rawExpressIp = String(req?.ip || req?.socket?.remoteAddress || "").trim();
  const expressIp = normalizeIp(rawExpressIp) || rawExpressIp || "unknown";
  if (isCloudflareWorkerSharedIp(expressIp)) {
    return {
      ip: expressIp,
      source: "cloudflare-worker-shared",
      isSharedProxy: true,
    };
  }

  return {
    ip: expressIp,
    source: "express-proxy",
    isSharedProxy: false,
  };
}

function getClientIp(req) {
  return resolveClientIdentity(req).ip;
}

function maskClientIp(ip) {
  const clean = String(ip || "unknown");
  const shortHash = crypto.createHash("sha256").update(clean).digest("hex").slice(0, 8);
  if (net.isIPv4(clean)) {
    const parts = clean.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.x#${shortHash}`;
  }
  if (net.isIPv6(clean)) {
    const parts = clean.split(":").slice(0, 3).join(":");
    return `${parts || "::"}:*#${shortHash}`;
  }
  return `unknown#${shortHash}`;
}

function normalizeEmail(req) {
  const raw = req?.body?.email;
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().slice(0, 320);
}

function emailHash(email) {
  if (!email) return "none";
  return crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 16);
}

function logRateLimit(event, fields) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    })
  );
}

// --------------------------
// Store backends
// --------------------------
function pruneMemoryMap(windowMs, now) {
  for (const [key, list] of memoryStore) {
    const live = list.filter((t) => now - t < windowMs);
    if (live.length === 0) memoryStore.delete(key);
    else memoryStore.set(key, live);
  }
  if (memoryStore.size > MEMORY_MAX_KEYS) {
    const oldest = [...memoryStore.entries()].sort(
      (a, b) => (a[1][0] || 0) - (b[1][0] || 0)
    );
    const excess = memoryStore.size - MEMORY_MAX_KEYS;
    for (let i = 0; i < excess; i += 1) {
      memoryStore.delete(oldest[i][0]);
    }
  }
}

function memoryGetLive(key, windowMs, now) {
  const list = memoryStore.get(key) || [];
  const live = list.filter((t) => now - t < windowMs);
  if (live.length === 0) memoryStore.delete(key);
  else memoryStore.set(key, live);
  return live;
}

function memoryRecordFailure(key, windowMs, now) {
  const live = memoryGetLive(key, windowMs, now);
  live.push(now);
  memoryStore.set(key, live);
  return live;
}

function memoryClearKey(key) {
  memoryStore.delete(key);
}

function activeSharedAdapter() {
  if (customSharedAdapter) return customSharedAdapter;
  const mode = String(process.env.LOGIN_RATE_LIMIT_STORE || "auto").toLowerCase();
  if (mode === "memory") return null;
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    return {
      name: "mongo",
      async getLive(key, windowMs, now) {
        const doc = await LoginRateLimitModel.findOne({ key }).lean();
        if (!doc || !Array.isArray(doc.failures)) return [];
        return doc.failures.filter((t) => now - t < windowMs);
      },
      async recordFailure(key, windowMs, now) {
        const cutoff = now - windowMs;
        const expiresAt = new Date(now + windowMs);
        const existing = await LoginRateLimitModel.findOne({ key });
        if (!existing) {
          try {
            await LoginRateLimitModel.create({
              key,
              failures: [now],
              expiresAt,
            });
            return [now];
          } catch (err) {
            if (err?.code !== 11000) throw err;
          }
        }
        const doc = await LoginRateLimitModel.findOne({ key });
        const live = (doc?.failures || []).filter((t) => t > cutoff);
        live.push(now);
        await LoginRateLimitModel.updateOne(
          { key },
          { $set: { failures: live, expiresAt } },
          { upsert: true }
        );
        return live;
      },
      async clearKey(key) {
        await LoginRateLimitModel.deleteOne({ key });
      },
    };
  }
  return null;
}

async function storeGetLive(key, windowMs, now) {
  const shared = activeSharedAdapter();
  if (shared) {
    try {
      return { entries: await shared.getLive(key, windowMs, now), store: shared.name || "shared" };
    } catch (err) {
      logRateLimit("auth.ratelimit.store_fallback", {
        reason: err?.name || "StoreReadError",
      });
    }
  }
  return { entries: memoryGetLive(key, windowMs, now), store: "memory" };
}

async function storeRecordFailure(key, windowMs, now) {
  // Always mirror in local memory so an abrupt DB blip never loses active protection.
  memoryRecordFailure(key, windowMs, now);
  const shared = activeSharedAdapter();
  if (shared) {
    try {
      await shared.recordFailure(key, windowMs, now);
    } catch (err) {
      logRateLimit("auth.ratelimit.store_fallback", {
        reason: err?.name || "StoreWriteError",
      });
    }
  }
}

async function storeClearKey(key) {
  memoryClearKey(key);
  const shared = activeSharedAdapter();
  if (shared) {
    try {
      await shared.clearKey(key);
    } catch (err) {
      logRateLimit("auth.ratelimit.store_fallback", {
        reason: err?.name || "StoreDeleteError",
      });
    }
  }
}

function buildBucketKeys(identifier, clientIdentity) {
  const cleanId = String(identifier || "").trim().toLowerCase();
  const ip = clientIdentity.ip;
  return {
    accountIpKey: cleanId ? `acct_ip:${cleanId}|${ip}` : null,
    ipKey: clientIdentity.isSharedProxy ? `shared_ip:${ip}` : `ip:${ip}`,
    accountGlobalKey:
      cleanId && !PUBLIC_DEMO_EMAILS.has(cleanId) ? `acct_global:${cleanId}` : null,
  };
}

function computeRetryAfter(failures, windowMs, now) {
  const oldestLive = failures[0] || now;
  return Math.max(1, Math.ceil((windowMs - (now - oldestLive)) / 1000));
}

async function checkLocked(req) {
  const {
    maxPerAccount,
    maxPerIp,
    maxPerAccountGlobal,
    maxSharedProxy,
    windowMs,
  } = getConfig();
  const now = Date.now();
  const email = normalizeEmail(req);
  const clientIdentity = resolveClientIdentity(req);
  const { accountIpKey, ipKey, accountGlobalKey } = buildBucketKeys(email, clientIdentity);

  pruneMemoryMap(windowMs, now);

  // 1. Primary check: (account + clientIp)
  if (accountIpKey) {
    const { entries, store } = await storeGetLive(accountIpKey, windowMs, now);
    if (entries.length >= maxPerAccount) {
      return {
        locked: true,
        retryAfterSeconds: computeRetryAfter(entries, windowMs, now),
        bucket: "account",
        store,
        clientIdentity,
      };
    }
  }

  // 2. Secondary check: clientIp (or high shared-proxy DoS ceiling)
  const ipLimit = clientIdentity.isSharedProxy ? maxSharedProxy : maxPerIp;
  const { entries: ipEntries, store: ipStore } = await storeGetLive(ipKey, windowMs, now);
  if (ipEntries.length >= ipLimit) {
    return {
      locked: true,
      retryAfterSeconds: computeRetryAfter(ipEntries, windowMs, now),
      bucket: clientIdentity.isSharedProxy ? "shared_proxy" : "ip",
      store: ipStore,
      clientIdentity,
    };
  }

  // 3. Tertiary check: global distributed brute-force per account across IPs
  if (accountGlobalKey) {
    const { entries: globalEntries, store: globalStore } = await storeGetLive(
      accountGlobalKey,
      windowMs,
      now
    );
    if (globalEntries.length >= maxPerAccountGlobal) {
      return {
        locked: true,
        retryAfterSeconds: computeRetryAfter(globalEntries, windowMs, now),
        bucket: "account_global",
        store: globalStore,
        clientIdentity,
      };
    }
  }

  return {
    locked: false,
    retryAfterSeconds: 0,
    bucket: null,
    store: activeSharedAdapter() ? "mongo" : "memory",
    clientIdentity,
  };
}

async function recordLoginFailure(req) {
  const { windowMs } = getConfig();
  const now = Date.now();
  const email = normalizeEmail(req);
  const clientIdentity = resolveClientIdentity(req);
  const { accountIpKey, ipKey, accountGlobalKey } = buildBucketKeys(email, clientIdentity);

  const tasks = [storeRecordFailure(ipKey, windowMs, now)];
  if (accountIpKey) tasks.push(storeRecordFailure(accountIpKey, windowMs, now));
  if (accountGlobalKey) tasks.push(storeRecordFailure(accountGlobalKey, windowMs, now));
  await Promise.all(tasks);
}

async function recordLoginSuccess(req, extraIdentifiers = []) {
  const email = normalizeEmail(req);
  const clientIdentity = resolveClientIdentity(req);
  const identifiers = new Set(
    [email, ...extraIdentifiers]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim().toLowerCase())
  );

  const tasks = [];
  for (const id of identifiers) {
    tasks.push(storeClearKey(`acct_ip:${id}|${clientIdentity.ip}`));
  }
  await Promise.all(tasks);
}

async function loginRateLimit(req, res, next) {
  try {
    const { locked, retryAfterSeconds, bucket, store, clientIdentity } = await checkLocked(req);
    req.authClientIdentity = clientIdentity;
    req.authRateLimitStore = store;

    if (!locked) return next();

    const email = normalizeEmail(req);
    logRateLimit("auth.login.rate_limited", {
      requestId: req.requestId || null,
      status: 429,
      bucket,
      store,
      accountRef: emailHash(email),
      clientId: maskClientIp(clientIdentity.ip),
      ipSource: clientIdentity.source,
      isSharedProxy: clientIdentity.isSharedProxy,
      retryAfterSeconds,
    });

    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      error: "Too many sign-in attempts. Please wait a moment and try again.",
      retryAfterSeconds,
      bucket: bucket === "ip" || bucket === "shared_proxy" ? "ip" : "account",
      requestId: req.requestId || null,
    });
  } catch (err) {
    // Rate-limiter internal failure must never crash Express or hang a login.
    logRateLimit("auth.ratelimit.error", {
      requestId: req.requestId || null,
      error: err?.name || "RateLimitError",
    });
    return next();
  }
}

function _resetStore() {
  memoryStore.clear();
}

function _setSharedStoreAdapter(adapter) {
  customSharedAdapter = adapter || null;
}

module.exports = {
  loginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  resolveClientIdentity,
  getClientIp,
  maskClientIp,
  normalizeEmail,
  emailHash,
  _resetStore,
  _setSharedStoreAdapter,
};
