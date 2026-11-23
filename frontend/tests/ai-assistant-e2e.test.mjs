// End-to-end & component integration tests for EduNova AI frontend status
// classification, capability gating, SSE/JSON chat streaming, session persistence,
// duplicate-submission guard, and honest UI states (Scenario 13).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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
const jwt = serverRequire("jsonwebtoken");
const mongoose = serverRequire("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "ai-frontend-e2e-secret";
process.env.AI_RATE_LIMIT_MAX_REQUESTS = "200";

const User = serverRequire("./models/User");
const QuizAttempt = serverRequire("./models/QuizAttempt");
const StudentProgress = serverRequire("./models/StudentProgress");
const AiAuditLog = serverRequire("./models/AiAuditLog");
const aiRoutes = serverRequire("./routes/ai");

const STUDENT_ID = new mongoose.Types.ObjectId().toString();
const tempFiles = [];

function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function installBrowserGlobals() {
  const local = createStorage();
  const session = createStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  globalThis.window = {
    location: { pathname: "/dashboard", origin: "http://127.0.0.1" },
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout: (fn, ms) => {
      const t = globalThis.setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (cb) => cb(),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    matchMedia: () => ({ matches: true }),
    localStorage: local,
    sessionStorage: session,
  };
  globalThis.document = {
    documentElement: { clientWidth: 1280, clientHeight: 800 },
  };
  return { local, session };
}

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

async function bundleFrontendAI(viteApiUrl) {
  const harnessEntry = `
    let hookStore = new Map();
    let activeKey = "root";
    let hookCursor = 0;

    function getBucket() {
      if (!hookStore.has(activeKey)) {
        hookStore.set(activeKey, { state: [], deps: [], cleanups: [] });
      }
      return hookStore.get(activeKey);
    }

    const Fragment = Symbol.for("react.fragment");

    const ReactRuntime = {
      Fragment,
      createElement(type, props, ...children) {
        const flat = children.flat(Infinity).filter((c) => c !== false && c !== null && c !== undefined);
        return { type, props: { ...(props || {}), children: flat } };
      },
      useState(initial) {
        const bucket = getBucket();
        const idx = hookCursor++;
        if (!(idx in bucket.state)) {
          bucket.state[idx] = typeof initial === "function" ? initial() : initial;
        }
        const setState = (updater) => {
          bucket.state[idx] = typeof updater === "function" ? updater(bucket.state[idx]) : updater;
        };
        return [bucket.state[idx], setState];
      },
      useRef(initial) {
        const bucket = getBucket();
        const idx = hookCursor++;
        if (!(idx in bucket.state)) {
          bucket.state[idx] = { current: initial };
        }
        return bucket.state[idx];
      },
      useCallback(fn, _deps) {
        hookCursor++;
        return fn;
      },
      useMemo(fn, _deps) {
        hookCursor++;
        return fn();
      },
      useId() {
        const idx = hookCursor++;
        return "edunova-id-" + idx;
      },
      useEffect(fn, deps) {
        const bucket = getBucket();
        const idx = hookCursor++;
        const prev = bucket.deps[idx];
        const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev[i]));
        bucket.deps[idx] = deps;
        if (changed) {
          if (typeof bucket.cleanups[idx] === "function") bucket.cleanups[idx]();
          bucket.cleanups[idx] = fn() || null;
        }
      },
    };

    function expandTree(node, pathKey = "root") {
      if (node === null || node === undefined || typeof node === "boolean") return null;
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) {
        return node.map((child, idx) => expandTree(child, pathKey + "." + idx)).filter((x) => x !== null);
      }
      if (typeof node.type === "function") {
        const prevKey = activeKey;
        const prevCursor = hookCursor;
        activeKey = pathKey + ":" + (node.type.name || "Component");
        hookCursor = 0;
        const rendered = node.type(node.props || {});
        activeKey = prevKey;
        hookCursor = prevCursor;
        return expandTree(rendered, activeKey + ">" + (node.type.name || "C"));
      }
      const rawChildren = Array.isArray(node.props?.children)
        ? node.props.children
        : node.props?.children !== undefined
          ? [node.props.children]
          : [];
      const expandedChildren = rawChildren
        .map((child, idx) => expandTree(child, pathKey + "/" + idx))
        .flat(Infinity)
        .filter((x) => x !== null);
      return {
        type: node.type === Fragment ? "fragment" : node.type,
        props: { ...(node.props || {}), children: expandedChildren },
      };
    }

    export { ReactRuntime };
    export function resetHarness() {
      for (const bucket of hookStore.values()) {
        for (const fn of bucket.cleanups) {
          if (typeof fn === "function") fn();
        }
      }
      hookStore.clear();
      activeKey = "root";
      hookCursor = 0;
    }
    export function renderComponent(Component, props = {}) {
      return expandTree({ type: Component, props }, "root");
    }
  `;

  const virtualReactPlugin = {
    name: "virtual-react-ai-harness",
    setup(build) {
      build.onResolve({ filter: /^virtual:ai-harness$/ }, () => ({
        path: "virtual:ai-harness",
        namespace: "virtual",
      }));
      build.onLoad({ filter: /^virtual:ai-harness$/, namespace: "virtual" }, () => ({
        contents: harnessEntry,
        loader: "js",
      }));
      build.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, () => ({
        path: "virtual:react",
        namespace: "virtual",
      }));
      build.onLoad({ filter: /^virtual:react$/, namespace: "virtual" }, () => ({
        contents: `
          import { ReactRuntime } from "virtual:ai-harness";
          export default ReactRuntime;
          export const Fragment = ReactRuntime.Fragment;
          export const useState = ReactRuntime.useState;
          export const useRef = ReactRuntime.useRef;
          export const useCallback = ReactRuntime.useCallback;
          export const useMemo = ReactRuntime.useMemo;
          export const useId = ReactRuntime.useId;
          export const useEffect = ReactRuntime.useEffect;
          export const jsx = (type, props) => {
            const { children, ...rest } = props || {};
            const childArr = Array.isArray(children) ? children : children !== undefined ? [children] : [];
            return ReactRuntime.createElement(type, rest, ...childArr);
          };
          export const jsxs = jsx;
        `,
        loader: "js",
      }));
    },
  };

  const entrySource = `
    import * as api from "./frontend/src/api/api.js";
    import FloatingAIChat from "./frontend/src/Components/FloatingAIChat.jsx";
    import AIChatAssistant from "./frontend/src/Components/AIChatAssistant.jsx";
    import { resetHarness, renderComponent } from "virtual:ai-harness";
    export { api, FloatingAIChat, AIChatAssistant, resetHarness, renderComponent };
  `;

  const result = await esbuild.build({
    stdin: {
      contents: entrySource,
      resolveDir: repoRoot,
      sourcefile: "ai-e2e-entry.jsx",
      loader: "jsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["axios"],
    plugins: [virtualReactPlugin],
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(viteApiUrl),
      "import.meta.env.PROD": "true",
    },
  });

  return importEsbuildCode(result.outputFiles[0].text, "ai-e2e");
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  for (const child of node.props?.children || []) {
    findAll(child, predicate, acc);
  }
  return acc;
}

function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.props?.children || []).map(textOf).join("");
}

let apiServer;
let apiOrigin;
let workerServer;
let workerOrigin;
let openAiServer;
let openAiPort;
const savedEnv = { ...process.env };
const savedFindById = User.findById;
const savedAttemptFindOne = QuizAttempt.findOne;
const savedAttemptFind = QuizAttempt.find;
const savedProgressFindOne = StudentProgress.findOne;
const savedAuditCreate = AiAuditLog.create;

function makeChain(result) {
  const c = {
    select: () => c,
    sort: () => c,
    limit: () => c,
    lean: () => Promise.resolve(result),
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  return c;
}

before(async () => {
  User.findById = (id) => {
    const u = {
      _id: String(id),
      name: "Demo Student",
      email: "student@edunova.demo",
      role: "student",
      subjects: ["Physics", "Mathematics"],
      enrolledClasses: ["10A"],
      isBlocked: false,
    };
    const p = Promise.resolve(u);
    p.select = () => Promise.resolve(u);
    return p;
  };
  QuizAttempt.findOne = () =>
    makeChain({
      _id: new mongoose.Types.ObjectId(),
      quizTitle: "Optics Practice Quiz",
      subject: "Physics",
      score: 80,
      totalQuestions: 5,
      correctAnswers: 4,
      weakTopics: ["Refraction"],
      answers: [],
      createdAt: new Date("2026-11-22T12:00:00Z"),
    });
  QuizAttempt.find = () =>
    makeChain([
      {
        _id: new mongoose.Types.ObjectId(),
        quizTitle: "Optics Practice Quiz",
        subject: "Physics",
        score: 80,
        totalQuestions: 5,
        correctAnswers: 4,
        weakTopics: ["Refraction"],
        createdAt: new Date("2026-11-22T12:00:00Z"),
      },
    ]);
  StudentProgress.findOne = () =>
    makeChain({
      overallProgressPercent: 80,
      studyStreakDays: 3,
      totalStudyMinutes: 120,
      subjects: [{ subject: "Physics", progressPercent: 80, weakTopics: ["Refraction"] }],
    });
  AiAuditLog.create = async () => ({});

  openAiServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const lastMsg = (body.messages || []).filter((m) => m.role === "user").pop()?.content || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-e2e",
          choices: [{ index: 0, message: { role: "assistant", content: `Verified answer for: ${lastMsg}` } }],
        })
      );
    });
  });
  await new Promise((r) => openAiServer.listen(0, "127.0.0.1", r));
  openAiPort = openAiServer.address().port;

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/ai", aiRoutes);
  apiServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;

  workerServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);
    const url = `http://127.0.0.1:${workerServer.address().port}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(", "));
      else if (v !== undefined) headers.set(k, v);
    }
    const cfReq = new Request(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuf,
    });
    const cfRes = await worker.fetch(cfReq, { BACKEND_URL: apiOrigin });
    const outHeaders = {};
    cfRes.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    res.writeHead(cfRes.status, outHeaders);
    const buf = Buffer.from(await cfRes.arrayBuffer());
    res.end(buf);
  });
  await new Promise((r) => workerServer.listen(0, "127.0.0.1", r));
  workerOrigin = `http://127.0.0.1:${workerServer.address().port}`;
});

after(async () => {
  await new Promise((r) => workerServer?.close(r));
  await new Promise((r) => apiServer?.close(r));
  await new Promise((r) => openAiServer?.close(r));
  User.findById = savedFindById;
  QuizAttempt.findOne = savedAttemptFindOne;
  QuizAttempt.find = savedAttemptFind;
  StudentProgress.findOne = savedProgressFindOne;
  AiAuditLog.create = savedAuditCreate;
  for (const f of tempFiles) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});

function signJwt(id = STUDENT_ID) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

describe("Scenario 13a: Frontend classifyAIHealth, getAIStatus, describeAICapabilities & streamAIEngine", () => {
  test("never emits 'AI status response is invalid' and accurately distinguishes healthy, degraded, not_configured, unavailable, invalid_response & network_failure", async () => {
    installBrowserGlobals();
    localStorage.setItem("token", signJwt());
    const { api } = await bundleFrontendAI(`${workerOrigin}/api`);

    // Compatibility checks required by learning.spec.mjs
    assert.equal(api.classifyAIHealth({ modelReady: true, readyForTraffic: true, status: "ready" }, 200), "ready");
    assert.equal(api.classifyAIHealth({ modelReady: false, status: "ready", permanentFailure: true }, 503), "unavailable");

    // 1. Missing configuration -> not_configured, capabilities all false
    process.env.AI_ENGINE_URL = "";
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_API_KEY;

    const statusUnconf = await api.getAIStatus();
    assert.equal(statusUnconf.status, api.AI_STATUS.NOT_CONFIGURED);
    assert.equal(statusUnconf.label, "AI service is not configured");
    assert.equal(statusUnconf.capabilities.timetable, false);
    assert.doesNotMatch(api.describeAICapabilities(statusUnconf), /Connected to your timetable/);

    // 2. Non-JSON 200 HTML upstream -> invalid_response ("Unable to verify AI service status")
    const htmlUpstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Portal Page</body></html>");
    });
    await new Promise((r) => htmlUpstream.listen(0, "127.0.0.1", r));
    process.env.AI_ENGINE_URL = `http://127.0.0.1:${htmlUpstream.address().port}`;

    const statusInvalid = await api.getAIStatus();
    await new Promise((r) => htmlUpstream.close(r));

    assert.equal(statusInvalid.status, api.AI_STATUS.INVALID_RESPONSE);
    assert.equal(statusInvalid.label, "Unable to verify AI service status");
    assert.ok(!JSON.stringify(statusInvalid).includes("AI status response is invalid"));
    assert.doesNotMatch(api.describeAICapabilities(statusInvalid), /Connected to your timetable/);

    // 3. Upstream 502 Bad Gateway HTML -> unavailable ("AI service is temporarily unavailable")
    const gw502 = http.createServer((_req, res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html>502 Bad Gateway</html>");
    });
    await new Promise((r) => gw502.listen(0, "127.0.0.1", r));
    process.env.AI_ENGINE_URL = `http://127.0.0.1:${gw502.address().port}`;

    const status502 = await api.getAIStatus();
    await new Promise((r) => gw502.close(r));

    assert.equal(status502.status, api.AI_STATUS.UNAVAILABLE);
    assert.equal(status502.label, "AI service is temporarily unavailable");
    assert.ok(!JSON.stringify(status502).includes("AI status response is invalid"));
    assert.doesNotMatch(api.describeAICapabilities(status502), /Connected to your timetable/);

    // 4. Healthy provider + DB ready -> ready ("AI assistant is ready") & full capability string
    const prevReadyState = mongoose.connection.readyState;
    mongoose.connection.readyState = 1;
    process.env.AI_ENGINE_URL = "";
    process.env.OPENAI_API_KEY = "sk-e2e-ok";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openAiPort}/v1`;
    process.env.OPENAI_MODEL = "gpt-4o-mini";

    const statusReady = await api.getAIStatus();
    assert.equal(statusReady.status, api.AI_STATUS.READY);
    assert.equal(statusReady.label, "AI assistant is ready");
    assert.equal(
      api.describeAICapabilities(statusReady),
      "Connected to your timetable, subjects, quiz scores, and verified research."
    );

    // 5. Degraded (DB disconnected while chat ready) -> degraded ("AI assistant is running with limited capabilities")
    mongoose.connection.readyState = 0;
    const statusDegraded = await api.getAIStatus();
    assert.equal(statusDegraded.status, api.AI_STATUS.DEGRADED);
    assert.equal(statusDegraded.label, "AI assistant is running with limited capabilities");
    assert.doesNotMatch(
      api.describeAICapabilities(statusDegraded),
      /Connected to your timetable, subjects, quiz scores/
    );
    mongoose.connection.readyState = prevReadyState;

    // 6. Network failure (closed port) -> network_failure ("Unable to reach AI service")
    const closedSrv = net.createServer();
    await new Promise((r) => closedSrv.listen(0, "127.0.0.1", r));
    const closedPort = closedSrv.address().port;
    await new Promise((r) => closedSrv.close(r));
    const offlineMod = await bundleFrontendAI(`http://127.0.0.1:${closedPort}/api`);
    const statusNet = await offlineMod.api.getAIStatus();
    assert.equal(statusNet.status, offlineMod.api.AI_STATUS.NETWORK_FAILURE);
    assert.equal(statusNet.label, "Unable to reach AI service");
  });
});

describe("Scenario 13b: FloatingAIChat & AIChatAssistant UI States, Prompts, Enter/Shift+Enter & Session Persistence", () => {
  test("FloatingAIChat hides capability claim when AI is unavailable and enables full chat, Enter/Shift+Enter, duplicate guard & session persistence when healthy", async () => {
    installBrowserGlobals();
    localStorage.setItem("token", signJwt());
    const prevReadyState = mongoose.connection.readyState;

    // --- Phase 1: AI is invalid/unavailable -> NO false capability claim ---
    mongoose.connection.readyState = 1;
    process.env.AI_ENGINE_URL = "";
    delete process.env.OPENAI_API_KEY;

    const mod = await bundleFrontendAI(`${workerOrigin}/api`);
    mod.resetHarness();

    let tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    // Open the floating chat panel via launcher button
    const launcherBtn = findAll(tree, (n) => n.type === "button" && n.props?.["aria-controls"] === "eduNova-ai-chat")[0];
    launcherBtn.props.onKeyDown({ key: "Enter", preventDefault() {} });

    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    // Let useAIStatus async tick resolve
    await new Promise((r) => setTimeout(r, 80));
    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });

    const unavailablePanelText = textOf(tree);
    assert.match(unavailablePanelText, /AI service is not configured/);
    assert.doesNotMatch(unavailablePanelText, /AI status response is invalid/);
    assert.doesNotMatch(
      unavailablePanelText,
      /Connected to your timetable, subjects, quiz scores, and verified research\./
    );

    // --- Phase 2: Switch backend to healthy -> capability summary appears & prompts send clean queries ---
    process.env.OPENAI_API_KEY = "sk-e2e-healthy";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openAiPort}/v1`;
    process.env.OPENAI_MODEL = "gpt-4o-mini";

    mod.resetHarness();
    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    const openBtn = findAll(tree, (n) => n.type === "button" && n.props?.["aria-controls"] === "eduNova-ai-chat")[0];
    openBtn.props.onKeyDown({ key: "Enter", preventDefault() {} });
    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    await new Promise((r) => setTimeout(r, 80));
    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });

    const healthyText = textOf(tree);
    assert.match(healthyText, /AI assistant is ready/);
    assert.match(healthyText, /Connected to your timetable, subjects, quiz scores, and verified research\./);

    // Verify all 4 suggested prompts exist and NONE send hardcoded "physics quiz"
    const quickButtons = findAll(
      tree,
      (n) =>
        n.type === "button" &&
        /What classes do I have today\?|What should I study today\?|Make me an exam study plan|Analyze my last quiz/.test(
          textOf(n)
        )
    );
    assert.equal(quickButtons.length, 4);

    // Empty/whitespace submission is ignored
    const textarea = findAll(tree, (n) => n.type === "textarea")[0];
    textarea.props.onChange({ target: { value: "   " } });
    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    const sendBtn = findAll(tree, (n) => n.type === "button" && n.props?.["aria-label"] === "Send message")[0];
    assert.equal(sendBtn.props.disabled, true, "whitespace-only input must keep Send disabled");

    // Shift+Enter does NOT submit; Enter DOES submit
    let prevented = false;
    const activeTextarea = findAll(tree, (n) => n.type === "textarea")[0];
    activeTextarea.props.onChange({ target: { value: "Line 1" } });
    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    findAll(tree, (n) => n.type === "textarea")[0].props.onKeyDown({
      key: "Enter",
      shiftKey: true,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, false, "Shift+Enter must allow newline without submitting");

    // Click "Analyze my last quiz" suggested button AND attempt rapid duplicate click in same tick
    const analyzeBtn = findAll(tree, (n) => n.type === "button" && /Analyze my last quiz/.test(textOf(n)))[0];
    const p1 = analyzeBtn.props.onClick();
    const p2 = analyzeBtn.props.onClick();
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 80));

    tree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    const afterChatText = textOf(tree);
    assert.match(afterChatText, /Analyze my last quiz\./);
    assert.doesNotMatch(afterChatText, /perform badly in my last physics quiz/i);
    assert.match(afterChatText, /Verified answer for: Analyze my last quiz\./);

    // Session persistence: remounting FloatingAIChat restores the conversation from sessionStorage
    mod.resetHarness();
    const remountedTree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    assert.match(textOf(remountedTree), /Verified answer for: Analyze my last quiz\./);

    // Clear button resets session chat cleanly
    const clearBtn = findAll(
      remountedTree,
      (n) => n.type === "button" && n.props?.["aria-label"] === "Clear EduNova AI conversation"
    )[0];
    assert.ok(clearBtn, "Clear conversation button should appear when messages exist");
    clearBtn.props.onClick();
    const clearedTree = mod.renderComponent(mod.FloatingAIChat, { feature: "dashboard" });
    assert.doesNotMatch(textOf(clearedTree), /Verified answer for: Analyze my last quiz\./);

    // Also verify AIChatAssistant preserves exact 'Ask EduNova AI' button label
    mod.resetHarness();
    let panelTree = mod.renderComponent(mod.AIChatAssistant, { feature: "ai" });
    await new Promise((r) => setTimeout(r, 80));
    panelTree = mod.renderComponent(mod.AIChatAssistant, { feature: "ai" });
    const askBtn = findAll(panelTree, (n) => n.type === "button" && /^Ask EduNova AI$/.test(textOf(n).trim()))[0];
    assert.ok(askBtn, "AIChatAssistant must preserve exact 'Ask EduNova AI' submit button label");
    assert.match(textOf(panelTree), /Connected to your timetable, subjects, quiz scores, and verified research\./);

    mod.resetHarness();
    mongoose.connection.readyState = prevReadyState;
  });
});
