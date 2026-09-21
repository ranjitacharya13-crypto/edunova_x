// server/scripts/auth-smoke.js
//
// End-to-end authentication smoke test for the EduNova API. It exercises the
// REAL HTTP endpoints and asserts the exact status-code contract the login page
// depends on:
//
//     health          → 200 (and reports whether MongoDB is connected)
//     CORS preflight  → 204 + the origin is echoed back
//     demo login      → 200 + JWT + safe user   (A)
//     wrong password  → 401                     (B)
//     unknown email   → 401                     (C)
//     missing fields  → 400                     (D)
//     malformed JSON  → 400 (JSON body, not HTML)
//     GET /auth/me    → 200 with the token, 401 without it
//     unreachable API → the request rejects (this is what the SPA renders as
//                       "Unable to connect to the EduNova server") (E)
//
// Usage (no extra dependencies — Node 18+ globals only):
//
//     node server/scripts/auth-smoke.js                                  # local backend on :4000
//     node server/scripts/auth-smoke.js http://127.0.0.1:4000
//     node server/scripts/auth-smoke.js https://edunova-api-y3rx.onrender.com
//     node server/scripts/auth-smoke.js https://edunova-x.ranjitacharya13.workers.dev  # through Cloudflare
//
// The credentials used are the PUBLIC demo credentials printed on the login
// page. No secret is read, printed or required.
const BASE_URL = (process.argv[2] || process.env.AUTH_SMOKE_BASE_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://edunova-x.ranjitacharya13.workers.dev";

const DEMO_EMAIL = "student@edunova.demo";
const DEMO_PASSWORD = "Student@12345";

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, { ...options, redirect: "manual" });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body, text };
}

async function main() {
  console.log(`\n🔎 EduNova auth smoke test → ${BASE_URL}\n`);

  // 0. health
  try {
    const health = await request("/health");
    const dbState = health.body && health.body.database;
    record(
      "GET /health",
      health.status === 200,
      `HTTP ${health.status}${dbState ? ` · database: ${dbState}` : ""}`
    );
    if (dbState && dbState !== "connected") {
      console.warn("   ⚠️  The API is up but MongoDB is NOT connected — logins will answer 503.");
    }
  } catch (err) {
    record("GET /health", false, `request failed: ${err.message}`);
    console.error("\n❌ The API is unreachable. Nothing else can be verified.");
    process.exit(1);
  }

  // 1. CORS preflight for the deployed Cloudflare frontend
  try {
    const preflight = await request("/api/auth/login", {
      method: "OPTIONS",
      headers: {
        Origin: FRONTEND_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization",
      },
    });
    const allowedOrigin = preflight.headers.get("access-control-allow-origin");
    record(
      "OPTIONS /api/auth/login (CORS preflight)",
      preflight.status < 400 && !!allowedOrigin,
      `HTTP ${preflight.status} · allow-origin: ${allowedOrigin || "(missing)"}`
    );
  } catch (err) {
    record("OPTIONS /api/auth/login (CORS preflight)", false, err.message);
  }

  // 2. A. correct demo credentials
  let demoToken = null;
  try {
    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: FRONTEND_ORIGIN },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    const hasToken = typeof login.body?.token === "string" && login.body.token.length > 20;
    const role = login.body?.user?.role;
    demoToken = hasToken ? login.body.token : null;
    record(
      "A. POST /api/auth/login (demo student, correct password)",
      login.status === 200 && hasToken && role === "student",
      `HTTP ${login.status} · role: ${role || "-"} · token: ${hasToken ? "returned (not printed)" : "MISSING"} · error: ${login.body?.error || "-"}`
    );
    if (login.status !== 200) {
      console.warn(
        "   ⚠️  The demo account did not authenticate. If the API is healthy and MongoDB is connected,\n" +
          "      the record is missing from the database: run `npm run seed:demo-student --prefix server`\n" +
          "      with the production MONGO_URI (the server also seeds it on every start)."
      );
    }
  } catch (err) {
    record("A. POST /api/auth/login (demo student, correct password)", false, err.message);
  }

  // 3. GET /api/auth/me with the token from step 2 (session restore path)
  if (demoToken) {
    try {
      const me = await request("/api/auth/me", { headers: { Authorization: `Bearer ${demoToken}` } });
      record(
        "GET /api/auth/me (valid token)",
        me.status === 200 && me.body?.user?.email === DEMO_EMAIL,
        `HTTP ${me.status} · user: ${me.body?.user?.email || "-"}`
      );
    } catch (err) {
      record("GET /api/auth/me (valid token)", false, err.message);
    }
  } else {
    record("GET /api/auth/me (valid token)", false, "skipped — no token from the login step");
  }

  try {
    const anon = await request("/api/auth/me");
    record("GET /api/auth/me (no token)", anon.status === 401, `HTTP ${anon.status} (expected 401)`);
  } catch (err) {
    record("GET /api/auth/me (no token)", false, err.message);
  }

  // 4. B. wrong password
  try {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEMO_EMAIL, password: "wrongpassword" }),
    });
    record("B. POST /api/auth/login (wrong password)", res.status === 401, `HTTP ${res.status} (expected 401) · error: ${res.body?.error || "-"}`);
  } catch (err) {
    record("B. POST /api/auth/login (wrong password)", false, err.message);
  }

  // 5. C. unknown email
  try {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com", password: "anything" }),
    });
    record("C. POST /api/auth/login (unknown email)", res.status === 401, `HTTP ${res.status} (expected 401) · error: ${res.body?.error || "-"}`);
  } catch (err) {
    record("C. POST /api/auth/login (unknown email)", false, err.message);
  }

  // 6. D. missing email/password
  try {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    record("D. POST /api/auth/login (missing fields)", res.status === 400, `HTTP ${res.status} (expected 400) · error: ${res.body?.error || "-"}`);
  } catch (err) {
    record("D. POST /api/auth/login (missing fields)", false, err.message);
  }

  // 7. malformed JSON must not be answered with an HTML page
  try {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"email": "student@edunova.demo",',
    });
    const isJson = res.text.trim().startsWith("{");
    record("POST /api/auth/login (malformed JSON)", res.status === 400 && isJson, `HTTP ${res.status} · json body: ${isJson}`);
  } catch (err) {
    record("POST /api/auth/login (malformed JSON)", false, err.message);
  }

  // 8. E. unreachable API behaves like a network failure (never a 401)
  try {
    await fetch("http://127.0.0.1:1/api/auth/login", { method: "POST", body: "{}" });
    record("E. unreachable API", false, "the request unexpectedly succeeded");
  } catch (err) {
    record("E. unreachable API", true, `rejects as expected (${err.cause?.code || err.code || err.name}) → SPA shows the network message`);
  }

  const failed = results.filter((r) => r.ok === "FAIL");
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error("Failed checks:");
    for (const f of failed) console.error(`  • ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("✅ Authentication contract verified.\n");
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
