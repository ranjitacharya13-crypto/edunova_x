// End-to-end integration test executing the REAL frontend Axios API client
// (frontend/src/api/api.js) and REAL LoginCard component
// (frontend/src/Components/LoginCard.jsx) through the Cloudflare Worker proxy
// (frontend/public/_worker.js) into a REAL Express HTTP server running
// server/routes/auth.js + server/middleware/loginRateLimit.js.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import workerImport from "../public/_worker.js";

const worker = workerImport?.default || workerImport;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const serverRequire = createRequire(path.join(repoRoot, "server/package.json"));

const express = serverRequire("express");
const cors = serverRequire("cors");
const bcrypt = serverRequire("bcryptjs");
const jwt = serverRequire("jsonwebtoken");
const mongoose = serverRequire("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-login-test-secret";

const User = serverRequire("./models/User");
const authRoutes = serverRequire("./routes/auth");
const rateLimit = serverRequire("./middleware/loginRateLimit");
const { ensureDemoStudent } = serverRequire("./services/demoAccount");

let apiServer;
let apiOrigin;
let workerServer;
let workerOrigin;
let hungServer;
let hungPort;

const users = [];

function installUserMemoryDb() {
  User.findOne = async (query = {}) => {
    const matchVal = (actual, expected) => {
      if (expected instanceof RegExp) return expected.test(String(actual || ""));
      if (expected && typeof expected === "object" && expected.$regex instanceof RegExp) {
        return expected.$regex.test(String(actual || ""));
      }
      return actual === expected;
    };
    if (Array.isArray(query.$or)) {
      return (
        users.find((u) =>
          query.$or.some((clause) => {
            const [k, v] = Object.entries(clause)[0];
            return matchVal(u[k], v);
          })
        ) || null
      );
    }
    if ("email" in query) {
      return users.find((u) => matchVal(u.email, query.email)) || null;
    }
    if ("username" in query) {
      return users.find((u) => matchVal(u.username, query.username)) || null;
    }
    return null;
  };

  User.findById = (id) => ({
    select: async () => users.find((u) => String(u._id) === String(id)) || null,
  });

  User.prototype.save = async function saveMem() {
    if (!this._id) this._id = new mongoose.Types.ObjectId();
    if (!users.includes(this)) users.push(this);
    return this;
  };
}

const tempFiles = [];

async function importEsbuildCode(code, prefix) {
  const cacheDir = path.join(repoRoot, "frontend/node_modules/.cache-e2e");
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(
    cacheDir,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
  );
  fs.writeFileSync(filePath, code, "utf8");
  tempFiles.push(filePath);
  return import(pathToFileURL(filePath).href);
}

async function bundleFrontendApi(viteApiUrl) {
  const result = await esbuild.build({
    entryPoints: [path.join(repoRoot, "frontend/src/api/api.js")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["axios"],
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(viteApiUrl),
      "import.meta.env.PROD": "true",
    },
  });
  return importEsbuildCode(result.outputFiles[0].text, "api");
}

async function bundleLoginCardWithHarness() {
  // Minimal stateful React hook runtime so we can execute LoginCard.jsx's exact
  // state machine, refs, effects, event handlers, and rendered element tree
  // deterministically in Node without needing a headless Chromium binary.
  const harnessEntry = `
    let currentHooks = [];
    let hookCursor = 0;
    const stateStore = [];
    const effectCleanups = [];

    const ReactRuntime = {
      createElement(type, props, ...children) {
        const flat = children.flat(Infinity).filter((c) => c !== false && c !== null && c !== undefined);
        return { type, props: { ...(props || {}), children: flat } };
      },
      useState(initial) {
        const idx = hookCursor++;
        if (!(idx in stateStore)) {
          stateStore[idx] = typeof initial === "function" ? initial() : initial;
        }
        const setState = (updater) => {
          stateStore[idx] = typeof updater === "function" ? updater(stateStore[idx]) : updater;
        };
        return [stateStore[idx], setState];
      },
      useRef(initial) {
        const idx = hookCursor++;
        if (!(idx in stateStore)) {
          stateStore[idx] = { current: initial };
        }
        return stateStore[idx];
      },
      useEffect(fn, deps) {
        const idx = hookCursor++;
        const prev = currentHooks[idx];
        const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
        currentHooks[idx] = { deps };
        if (changed) {
          if (typeof effectCleanups[idx] === "function") effectCleanups[idx]();
          effectCleanups[idx] = fn() || null;
        }
      },
    };

    export { ReactRuntime, stateStore, currentHooks, effectCleanups };
    export function resetHarness() {
      currentHooks = [];
      hookCursor = 0;
      stateStore.length = 0;
      for (const fn of effectCleanups) {
        if (typeof fn === "function") fn();
      }
      effectCleanups.length = 0;
    }
    export function renderWithHarness(Component, props) {
      hookCursor = 0;
      return Component(props);
    }
  `;

  const virtualReactPlugin = {
    name: "virtual-react-harness",
    setup(build) {
      build.onResolve({ filter: /^virtual:harness$/ }, () => ({
        path: "virtual:harness",
        namespace: "virtual",
      }));
      build.onLoad({ filter: /^virtual:harness$/, namespace: "virtual" }, () => ({
        contents: harnessEntry,
        loader: "js",
      }));
      build.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, () => ({
        path: "virtual:react",
        namespace: "virtual",
      }));
      build.onLoad({ filter: /^virtual:react$/, namespace: "virtual" }, () => ({
        contents: `
          import { ReactRuntime } from "virtual:harness";
          export default ReactRuntime;
          export const useState = ReactRuntime.useState;
          export const useRef = ReactRuntime.useRef;
          export const useEffect = ReactRuntime.useEffect;
          export const jsx = (type, props) => ReactRuntime.createElement(type, props);
          export const jsxs = (type, props) => ReactRuntime.createElement(type, props);
        `,
        loader: "js",
      }));
    },
  };

  const entrySource = `
    import LoginCard from "./frontend/src/Components/LoginCard.jsx";
    import { resetHarness, renderWithHarness } from "virtual:harness";
    export { LoginCard, resetHarness, renderWithHarness };
  `;

  const result = await esbuild.build({
    stdin: {
      contents: entrySource,
      resolveDir: repoRoot,
      loader: "jsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["axios"],
    jsx: "transform",
    jsxFactory: "React.createElement",
    plugins: [virtualReactPlugin],
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify("http://127.0.0.1:1/api"),
      "import.meta.env.PROD": "false",
    },
  });
  return importEsbuildCode(result.outputFiles[0].text, "login-card");
}

function findAllNodes(node, predicate, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (predicate(node)) acc.push(node);
  const children = node.props?.children || [];
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) findAllNodes(child, predicate, acc);
  return acc;
}

function nodeText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const children = node.props?.children || [];
  const list = Array.isArray(children) ? children : [children];
  return list.map(nodeText).join("");
}

before(async () => {
  installUserMemoryDb();
  mongoose.connection.readyState = 1;
  process.env.PROXY_SECRET = "e2e-worker-secret";

  await ensureDemoStudent({ log: { log() {}, warn() {}, error() {} } });
  const pwHash = await bcrypt.hash("ValidPass@123", 4);
  users.push(
    new User({
      name: "Real Student",
      username: "real_student",
      email: "real@edunova.test",
      password: pwHash,
      role: "student",
    })
  );

  const app = express();
  app.set("trust proxy", 2);
  app.use(
    cors({
      origin: true,
      exposedHeaders: ["Retry-After", "X-Request-Id"],
    })
  );
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  // Simulated AI route returning 401 AUTH_FAILED (internal AI token mismatch)
  app.post("/api/ai/chat", (_req, res) => {
    res.status(401).json({
      success: false,
      error: { code: "AUTH_FAILED", message: "AI internal token mismatch" },
    });
  });

  apiServer = http.createServer(app);
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;

  // Local HTTP wrapper around frontend/public/_worker.js (Cloudflare Worker proxy)
  workerServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);
    const url = `http://127.0.0.1:${workerServer.address().port}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(", "));
      else if (v != null) headers.set(k, v);
    }
    if (!headers.has("cf-connecting-ip")) {
      headers.set("cf-connecting-ip", "49.37.200.10");
    }
    const cfReq = new Request(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuf,
    });
    const cfRes = await worker.fetch(cfReq, {
      BACKEND_URL: apiOrigin,
      PROXY_SECRET: "e2e-worker-secret",
    });
    res.statusCode = cfRes.status;
    cfRes.headers.forEach((val, key) => res.setHeader(key, val));
    const respBuf = Buffer.from(await cfRes.arrayBuffer());
    res.end(respBuf);
  });
  await new Promise((r) => workerServer.listen(0, "127.0.0.1", r));
  workerOrigin = `http://127.0.0.1:${workerServer.address().port}`;

  // Raw TCP server that accepts connections and never responds (tests timeout recovery)
  hungServer = net.createServer((socket) => {
    socket.on("error", () => {});
  });
  await new Promise((r) => hungServer.listen(0, "127.0.0.1", r));
  hungPort = hungServer.address().port;
});

after(async () => {
  delete process.env.PROXY_SECRET;
  mongoose.connection.readyState = 0;
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
  await new Promise((r) => apiServer.close(r));
  await new Promise((r) => workerServer.close(r));
  await new Promise((r) => hungServer.close(r));
});

describe("Frontend API client -> Cloudflare Worker -> Express API end-to-end", () => {
  test("valid login, demo student login, and /api/auth/me JWT verification succeed through Worker proxy", async () => {
    rateLimit._resetStore();
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };

    const apiMod = await bundleFrontendApi(`${workerOrigin}/api`);

    // 1. Valid student login
    const valid = await apiMod.loginUser({
      email: "  REAL@edunova.test ",
      password: "ValidPass@123",
    });
    assert.ok(valid.token);
    assert.equal(valid.user.email, "real@edunova.test");

    // 2. Demo student login
    const demo = await apiMod.loginUser({
      email: "student@edunova.demo",
      password: "Student@12345",
    });
    assert.ok(demo.token);
    assert.equal(demo.user.email, "student@edunova.demo");
    assert.equal(demo.user.role, "student");

    // 3. Post-login JWT check against GET /api/auth/me
    const me = await apiMod.getCurrentUser(demo.token);
    assert.equal(me.status, 200);
    assert.equal(me.user.email, "student@edunova.demo");
  });

  test("expired JWT dispatches edunova:auth-expired, while AI AUTH_FAILED 401 does NOT log user out", async () => {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
    const events = [];
    const target = new EventTarget();
    globalThis.window = {
      dispatchEvent: (ev) => target.dispatchEvent(ev),
      addEventListener: (n, fn) => target.addEventListener(n, fn),
      removeEventListener: (n, fn) => target.removeEventListener(n, fn),
    };
    globalThis.CustomEvent =
      globalThis.CustomEvent ||
      class CustomEvent extends Event {
        constructor(name, init) {
          super(name);
          this.detail = init?.detail;
        }
      };
    window.addEventListener("edunova:auth-expired", (e) => events.push(e.detail));

    const apiMod = await bundleFrontendApi(`${workerOrigin}/api`);
    const demo = await apiMod.loginUser({
      email: "student@edunova.demo",
      password: "Student@12345",
    });
    localStorage.setItem("token", demo.token);

    // Calling /api/ai/chat returns 401 AUTH_FAILED (AI service internal token),
    // which MUST NOT invalidate the user's EduNova session!
    await assert.rejects(() =>
      apiMod.API.post(
        "/ai/chat",
        { message: "hello" },
        { headers: { Authorization: `Bearer ${demo.token}` } }
      )
    );
    assert.equal(events.length, 0);
    assert.equal(localStorage.getItem("token"), demo.token);

    // Calling an endpoint with an expired JWT DOES emit edunova:auth-expired & clears token
    const serverExpiredJwt = jwt.sign(
      { id: demo.user.id, role: "student" },
      process.env.JWT_SECRET,
      { expiresIn: -5 }
    );
    localStorage.setItem("token", serverExpiredJwt);
    await assert.rejects(() =>
      apiMod.API.get("/auth/me", {
        headers: { Authorization: `Bearer ${serverExpiredJwt}` },
      })
    );
    assert.ok(events.length >= 1);
    assert.equal(localStorage.getItem("token"), null);
    delete globalThis.window;
  });

  test("10. backend unavailable (closed port) and hung backend (timeout) return clean errors without throwing", async () => {
    // Find an unused closed port
    const tempSrv = net.createServer();
    await new Promise((r) => tempSrv.listen(0, "127.0.0.1", r));
    const closedPort = tempSrv.address().port;
    await new Promise((r) => tempSrv.close(r));

    const deadApi = await bundleFrontendApi(`http://127.0.0.1:${closedPort}/api`);
    const deadRes = await deadApi.loginUser({
      email: "student@edunova.demo",
      password: "Student@12345",
    });
    assert.match(deadRes.error, /Cannot reach the server/);

    // Hung socket timeout test via API.post with short timeout mapped by loginUser's mapper
    const hungApi = await bundleFrontendApi(`http://127.0.0.1:${hungPort}/api`);
    await assert.rejects(
      () => hungApi.API.post("/auth/login", { email: "a", password: "b" }, { timeout: 120 }),
      (err) => err.code === "ECONNABORTED"
    );
  });
});

describe("11. LoginCard component — loading-state recovery, duplicate-submit guard, and 429 isolation", () => {
  test("never stays stuck on Signing in..., blocks rapid double-submit, and isolates per-account 429 from Demo Student", async () => {
    const { LoginCard, resetHarness, renderWithHarness } =
      await bundleLoginCardWithHarness();

    // --- Case A: synchronous double-submit & guaranteed recovery on failure ---
    resetHarness();
    let resolveInFlight;
    let calls = 0;
    const props = {
      onLogin: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveInFlight = resolve;
        });
      },
    };

    let tree = renderWithHarness(LoginCard, props);
    const inputs = findAllNodes(tree, (n) => n.type === "input");
    inputs[0].props.onChange({ target: { value: "alice@example.test" } });
    inputs[1].props.onChange({ target: { value: "wrong" } });

    tree = renderWithHarness(LoginCard, props);
    const form = findAllNodes(tree, (n) => n.type === "form")[0];

    // Rapid double submit in the same tick -> inFlightRef blocks the second call!
    const p1 = form.props.onSubmit({ preventDefault() {} });
    const p2 = form.props.onSubmit({ preventDefault() {} });
    assert.equal(calls, 1, "duplicate synchronous submit must be blocked");

    // While in flight: manual button says "Signing in..." & is disabled;
    // Demo Student button stays labeled "Login as Demo Student" & is disabled.
    tree = renderWithHarness(LoginCard, props);
    const buttonsInFlight = findAllNodes(tree, (n) => n.type === "button");
    assert.equal(nodeText(buttonsInFlight[0]), "Signing in...");
    assert.equal(buttonsInFlight[0].props.disabled, true);
    assert.equal(nodeText(buttonsInFlight[2]), "Login as Demo Student");
    assert.equal(buttonsInFlight[2].props.disabled, true);

    // Resolve with 401 failure -> loading MUST reset back to "Sign In" & re-enable!
    resolveInFlight({ error: "Invalid credentials", status: 401, retryAfterSeconds: 0 });
    await Promise.all([p1, p2]);

    tree = renderWithHarness(LoginCard, props);
    const buttonsAfter401 = findAllNodes(tree, (n) => n.type === "button");
    assert.equal(nodeText(buttonsAfter401[0]), "Sign In");
    assert.equal(buttonsAfter401[0].props.disabled, false);
    assert.equal(buttonsAfter401[2].props.disabled, false);
    const alert401 = findAllNodes(tree, (n) => n.props?.role === "alert")[0];
    assert.equal(nodeText(alert401), "Invalid credentials");

    // --- Case B: even if onLogin throws unexpectedly, finally resets loading! ---
    const throwProps = {
      onLogin: async () => {
        throw new Error("Unexpected boom");
      },
    };
    tree = renderWithHarness(LoginCard, throwProps);
    await findAllNodes(tree, (n) => n.type === "form")[0].props.onSubmit({
      preventDefault() {},
    });
    tree = renderWithHarness(LoginCard, throwProps);
    const buttonsAfterThrow = findAllNodes(tree, (n) => n.type === "button");
    assert.equal(nodeText(buttonsAfterThrow[0]), "Sign In");
    assert.equal(buttonsAfterThrow[0].props.disabled, false);

    // --- Case C: per-account 429 locks ONLY that email; Demo Student & other emails stay enabled! ---
    const rateLimitProps = {
      onLogin: async () => ({
        error: "Too many sign-in attempts. Please wait a moment and try again.",
        status: 429,
        retryAfterSeconds: 30,
        bucket: "account",
      }),
    };
    tree = renderWithHarness(LoginCard, rateLimitProps);
    await findAllNodes(tree, (n) => n.type === "form")[0].props.onSubmit({
      preventDefault() {},
    });

    tree = renderWithHarness(LoginCard, rateLimitProps);
    const buttonsAfter429 = findAllNodes(tree, (n) => n.type === "button");
    assert.equal(nodeText(buttonsAfter429[0]), "Try again in 30s");
    assert.equal(buttonsAfter429[0].props.disabled, true);
    // Demo Student button MUST remain enabled so visitors can still use Demo Student!
    assert.equal(nodeText(buttonsAfter429[2]), "Login as Demo Student");
    assert.equal(buttonsAfter429[2].props.disabled, false);

    // Changing email to another account immediately re-enables Sign In!
    const inputsAfter429 = findAllNodes(tree, (n) => n.type === "input");
    inputsAfter429[0].props.onChange({ target: { value: "bob@example.test" } });
    tree = renderWithHarness(LoginCard, rateLimitProps);
    const buttonsSwitched = findAllNodes(tree, (n) => n.type === "button");
    assert.equal(nodeText(buttonsSwitched[0]), "Sign In");
    assert.equal(buttonsSwitched[0].props.disabled, false);

    resetHarness();
  });
});
