# Login authentication failure — root cause and fix

**Date:** 2026-09-21 · **Branch:** `arena/01a0c347-edunova-x` (PR #73)
**Symptom:** the deployed login page showed `Invalid credentials`; DevTools showed
`Failed to load resource: the server responded with a status of 400 ()` for
`POST /api/auth/login`.

---

## 1. Root cause

Traced end to end: `LoginCard` → `Dashboard.onLogin` → `loginUser()` (`api.js`)
→ `axios` → `POST <VITE_API_URL>/auth/login` → Express `express.json()` →
`server/routes/auth.js` → `User.findOne` → `bcrypt.compare` → `jwt.sign`.

The request reached the API correctly (`{"email","password"}`, JSON content type),
so the failure was inside the authentication route. Two defects combined:

1. **The published demo account had no row in the deployed database.**
   `server/server.js` created `student@edunova.demo` only when
   `NODE_ENV !== "production" && SEED_DEMO_USERS === "true"`. On Render
   `NODE_ENV=production` and `render.yaml` pins `SEED_DEMO_USERS=false`, so the
   account was never seeded; `server/seed/createDemoStudent.js` had to be run by
   hand with the production `MONGO_URI` and was not part of any deploy step.
   The login card advertised credentials that did not exist → `User.findOne`
   returned `null`.
   The same 400 appears when the stored hash no longer matches the published
   password (manually created user, stale hash, or a plaintext value).

2. **Every authentication failure was answered with HTTP 400.**
   `server/routes/auth.js` returned `400 {"error":"Invalid credentials"}` for
   *unknown user*, *wrong password* and *missing fields* alike. That is the 400
   in DevTools. It also meant that a MongoDB outage or a missing `JWT_SECRET`
   was reported to the user as "wrong password".

   Note: the API itself was healthy — `GET https://edunova-api-y3rx.onrender.com/health`
   answered `{"status":"ok","service":"edunova-api","version":"5.0.0","database":"connected"}`
   and `GET /` matched this repository's code exactly, so the deployment was
   running the current backend and MongoDB was reachable. The problem was the
   missing record plus the misleading status code/message.

3. **The SPA collapsed all failures into one message.**
   `loginUser()` returned `err.response?.data?.error || "Invalid credentials"`,
   so a network error, a 500 and a 401 were indistinguishable.

## 2. Files changed

Backend: `server/routes/auth.js`, `server/server.js`, `server/models/User.js`,
`server/middleware/auth.js`, `server/services/database.js` *(new)*,
`server/services/demoAccount.js` *(new)*, `server/seed/createDemoStudent.js`,
`server/scripts/auth-smoke.js` *(new)*, `server/test/auth-login.test.js` *(new)*,
`server/test/demo-account.test.js` *(new)*.

Frontend: `frontend/src/api/authErrors.js` *(new)*, `frontend/src/api/api.js`,
`frontend/src/Components/LoginCard.jsx`,
`frontend/src/Components/Dashboard.jsx`, `frontend/src/App.jsx`,
`frontend/tests/authErrors.node.mjs` *(new)*, `frontend/package.json`.

Config/docs: `render.yaml`, `.env.example`, `DEPLOYMENT.md`.

## 3. Code fix

* **Status codes tell the truth** — 400 = malformed/missing request data,
  401 = wrong credentials (one generic message; no account enumeration),
  500 = server misconfigured (`JWT_SECRET` missing), 503 = MongoDB not
  connected. The password is only ever checked with
  `bcrypt.compare(raw, hash)`; an unknown user still costs one bcrypt
  comparison (timing), and passwords are never logged (diagnostics use a masked
  identifier, e.g. `s***@edunova.demo`).
* **Server-side guards** — `services/database.js` exposes the MongoDB readiness
  probe; missing `JWT_SECRET` and a disconnected database now produce 500/503
  with a clear reason instead of "Invalid credentials".
* **`GET /api/auth/me`** — the SPA re-validates a stored JWT against the backend
  on load; an invalid/expired token is dropped.
* **`express.json()`** stays registered before the routes, and a malformed JSON
  body now returns JSON `400` instead of Express's HTML error page.
* **Frontend error mapping** — 400 → "Please enter a valid email and password.",
  401 → "Invalid email or password.", 5xx → "Server error. Please try again."
  (503 also names the database), no response → "Unable to connect to the EduNova
  server." The demo button fills the fields and submits through the same
  `authenticate()` path as the form; the dashboard opens only for a response
  containing both a token and a user (admin → admin dashboard, student/teacher →
  home).

## 4. Database

The demo student is now provisioned **idempotently on every server start** by
`server/services/demoAccount.js` (`SEED_DEMO_STUDENT`, default `true`):

```
findOne({ email: "student@edunova.demo" })
  ├─ missing            → create {name, username, email, bcrypt hash, role: "student"}
  ├─ exists (student)   → no-op; if the hash does not verify the published demo
  │                       password, re-hash it (bcrypt, cost 10)
  └─ exists (other role/username) → leave untouched, log a warning
```

* The password is stored **only** as a bcrypt hash (cost 10, same library as the
  register/login routes) — never plaintext.
* No duplicates on restart, no admin/teacher creation, no privilege escalation,
  no overwriting of a real user's account.
* Manual run (any database): `MONGO_URI="<atlas-uri>" npm run seed:demo-student --prefix server`
  (or `node server/seed/createDemoStudent.js`).

## 5. Environment variables

| Variable | Service | Notes |
|---|---|---|
| `MONGO_URI` | Render backend | **not** `MONGODB_URI`. Atlas Network Access must allow `0.0.0.0/0`. |
| `JWT_SECRET` | Render backend | generated by the Blueprint; login returns 500 if missing. Never a `VITE_*` variable. |
| `CORS_ORIGIN` | Render backend | `https://edunova-x.ranjitacharya13.workers.dev` (the Workers origin is always allowed, including `*.ranjitacharya13.workers.dev` previews). |
| `FRONTEND_URL` | Render backend | optional single-origin alias. |
| `SEED_DEMO_STUDENT` | Render backend | default `true`; provisions the demo student. |
| `DEMO_STUDENT_PASSWORD` | Render backend | optional override; must match the password printed on the login page. |
| `SEED_DEMO_USERS` | Render backend | legacy weak demo accounts; ignored when `NODE_ENV=production`. |
| `VITE_API_URL` | Cloudflare (build time) | `https://edunova-api-y3rx.onrender.com/api`; public, never a secret. |
| `BACKEND_URL` | Cloudflare Worker var | `https://edunova-api-y3rx.onrender.com` (proxy target when the bundle calls `/api`). |

## 6. API test

```bash
curl -s -X POST https://edunova-api-y3rx.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"student@edunova.demo","password":"Student@12345"}'
```

| Case | Status | Body |
|---|---|---|
| correct demo credentials | `200` | `{"token":"<jwt>","user":{"id","name","email","role":"student","username"}}` |
| wrong password | `401` | `{"error":"Invalid credentials"}` |
| unknown email | `401` | `{"error":"Invalid credentials"}` |
| missing/empty fields | `400` | `{"error":"Email and password are required"}` |
| malformed JSON body | `400` | `{"error":"Malformed JSON body"}` |
| MongoDB not connected | `503` | `{"error":"Database unavailable (disconnected). Please try again in a moment."}` |
| `JWT_SECRET` missing | `500` | `{"error":"Server configuration error: authentication is not configured (JWT_SECRET missing)"}` |

Automated: `node server/scripts/auth-smoke.js <base-url>` (local, Render, or the
Cloudflare URL) runs all of the above plus the CORS preflight and
`GET /api/auth/me`, and exits non-zero on any mismatch.

## 7. Deployment checklist

1. **Render (`edunova-api`)** — merged `main` auto-deploys; verify `MONGO_URI`,
   `JWT_SECRET`, `CORS_ORIGIN`, `SEED_DEMO_STUDENT=true`.
2. **MongoDB Atlas** — allow `0.0.0.0/0`; after deploy the logs show
   `✅ MongoDB connected` and `✅ Demo student ready: student@edunova.demo`
   (or `✅ Seeded demo student: …`).
3. **Cloudflare** — redeploy the Worker so the new bundle ships
   (`VITE_API_URL` set at build time, or the Worker's `BACKEND_URL`).
4. **Verify** — `node server/scripts/auth-smoke.js https://edunova-api-y3rx.onrender.com`
   and the same command against `https://edunova-x.ranjitacharya13.workers.dev`,
   then press **Login as Demo Student** on the deployed site → Student Dashboard.

## 8. Verification performed for this fix

* `npm test --prefix server` → 41 pass / 0 fail (6 Mongo-dependent skips).
* `npm run test:auth-errors --prefix frontend` → 9/9 status-code mappings.
* `npm run build --prefix frontend` → OK; the production bundle contains
  `https://edunova-api-y3rx.onrender.com/api` and no `localhost` API URL.
* Real Express server (production `NODE_ENV`, demo seeding active) with
  `node server/scripts/auth-smoke.js` → **10/10** checks (200/401/401/400/400/503/500,
  CORS preflight, `/me`, unreachable-API case).
* The real `frontend/public/_worker.js` Cloudflare proxy was executed as the
  edge in front of that server: the POST body arrives intact and the API
  status/JSON is returned unchanged.
* The real `LoginCard` was rendered in a DOM (jsdom) and driven with real click
  and submit events against the running API: the demo button fills
  `student@edunova.demo` / `Student@12345`, receives a token, stores it and lands
  on `view=home` (Student Dashboard); wrong password → "Invalid email or
  password."; unknown email → the same; empty form → "Please enter a valid email
  and password."; dead backend → the network message; 5xx → a server message.
* Cloudflare's own build for this branch ("Workers Builds: edunova-x") passes.
  The two failing Vercel statuses also fail on `main` and come from a legacy
  Vercel integration that is not part of the documented deployment.

**Not verifiable from the development sandbox:** outbound HTTPS to
`*.onrender.com` is blocked there, so the contents of the deployed Atlas
database could not be read directly and the live login could not be replayed.
This fix does not depend on that: the deployed backend recreates the demo
record itself on its next start.
