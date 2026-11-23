// server/services/aiAssistantService.js
//
// Unified AI status normalization & authenticated data-aware query controller
// for EduNova AI.
//
// Principles:
// 1. Honest status reporting: distinguishes `healthy`, `degraded`,
//    `not_configured`, `unavailable`, and `invalid_response`. Never reports
//    healthy when the AI engine/provider is unavailable, and never claims
//    database or research capabilities unless genuinely active.
// 2. Zero-trust student scoping: every student tool call executes strictly with
//    the JWT-authenticated `userId`, never user-supplied IDs.
// 3. Real inference only: uses either the dedicated `edunova-ai` engine
//    (`AI_ENGINE_URL`) or a configured server-side OpenAI-compatible provider
//    (`LLM_API_KEY` / `OPENAI_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` /
//    `OPENROUTER_API_KEY`). Never fabricates answers, student records, or
//    research citations.

const crypto = require("node:crypto");
const axios = require("axios");
const mongoose = require("mongoose");
const { executeApplicationTool } = require("./applicationTools");

const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONVERSATION_TURNS = 12;
const MAX_CONVERSATIONS = 500;
const conversationStore = new Map();

const SUBJECT_LEXICON = [
  "physics", "chemistry", "biology", "mathematics", "maths", "math",
  "computer science", "computers", "english", "tamil", "hindi",
  "social science", "social", "history", "geography", "economics",
  "commerce", "accountancy", "botany", "zoology", "statistics",
  "python", "java", "machine learning", "data structures",
];

function stripQuotes(value) {
  let v = String(value || "").trim();
  while (v.length >= 2 && "\"'`".includes(v[0]) && v[0] === v[v.length - 1]) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function sanitizeProviderError(raw, fallback = "AI provider request failed") {
  let text = String(raw || "").trim();
  if (!text) return fallback;
  if (text.includes("<") && text.includes(">")) {
    text = text.replace(/<[^>]*>/g, " ");
  }
  text = text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/gsk_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (text || fallback).slice(0, 280);
}

/**
 * Inspect server-side environment variables for a direct OpenAI-compatible
 * inference provider configured on `edunova-api`.
 */
function resolveDirectProviderConfig() {
  const candidates = [
    {
      name: process.env.LLM_PROVIDER_NAME || "openai-compatible",
      apiKey: stripQuotes(process.env.LLM_API_KEY),
      baseUrl: stripQuotes(process.env.LLM_BASE_URL) || "https://api.openai.com/v1",
      model: stripQuotes(process.env.LLM_MODEL) || "gpt-4o-mini",
    },
    {
      name: "openai",
      apiKey: stripQuotes(process.env.OPENAI_API_KEY),
      baseUrl: stripQuotes(process.env.OPENAI_BASE_URL) || "https://api.openai.com/v1",
      model: stripQuotes(process.env.OPENAI_MODEL) || "gpt-4o-mini",
    },
    {
      name: "groq",
      apiKey: stripQuotes(process.env.GROQ_API_KEY),
      baseUrl: stripQuotes(process.env.GROQ_BASE_URL) || "https://api.groq.com/openai/v1",
      model: stripQuotes(process.env.GROQ_MODEL) || "llama-3.1-8b-instant",
    },
    {
      name: "gemini",
      apiKey: stripQuotes(process.env.GEMINI_API_KEY),
      baseUrl:
        stripQuotes(process.env.GEMINI_BASE_URL) ||
        "https://generativelanguage.googleapis.com/v1beta/openai",
      model: stripQuotes(process.env.GEMINI_MODEL) || "gemini-2.0-flash",
    },
    {
      name: "openrouter",
      apiKey: stripQuotes(process.env.OPENROUTER_API_KEY),
      baseUrl: stripQuotes(process.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1",
      model:
        stripQuotes(process.env.OPENROUTER_MODEL) ||
        "meta-llama/llama-3.1-8b-instruct",
    },
  ];

  const match = candidates.find((c) => Boolean(c.apiKey));
  if (!match) return null;

  const baseUrl = match.baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    return {
      configured: false,
      invalidConfig: true,
      name: match.name,
      error: "Configured LLM_BASE_URL is not a valid HTTP(S) URL",
    };
  }

  return {
    configured: true,
    invalidConfig: false,
    name: match.name,
    apiKey: match.apiKey,
    baseUrl,
    model: match.model,
    timeoutMs: Math.max(5000, Math.min(Number(process.env.LLM_REQUEST_TIMEOUT_MS) || 45000, 120000)),
  };
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

function isResearchSupported(upstreamPayload = null) {
  if (upstreamPayload && typeof upstreamPayload.searchConfigured === "boolean") {
    return upstreamPayload.searchConfigured;
  }
  const provider = String(process.env.WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
  if (["none", "off", "disabled", "false"].includes(provider)) return false;
  if (["brave", "tavily", "serper"].includes(provider)) {
    return Boolean(stripQuotes(process.env.WEB_SEARCH_API_KEY));
  }
  return true;
}

function buildCapabilities({ chatReady, dbReady, researchReady }) {
  const dataReady = Boolean(chatReady && dbReady);
  return {
    chat: Boolean(chatReady),
    timetable: dataReady,
    subjects: dataReady,
    quizAnalysis: dataReady,
    studyPlanning: dataReady,
    research: Boolean(chatReady && researchReady),
  };
}

function inferUpstreamProviderName(payload) {
  if (!payload || typeof payload !== "object") return "edunova-ai";
  if (typeof payload.provider === "string" && payload.provider.trim()) {
    return payload.provider.trim();
  }
  const runtime = payload.model?.runtime || payload.runtime || "";
  if (/llama/i.test(runtime)) return "edunova-local-gguf";
  if (/hrm/i.test(runtime)) return "edunova-local-hrm";
  if (/openai/i.test(runtime)) return "openai-compatible";
  return "edunova-ai";
}

function hasRecognizedHealthSchema(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (
    typeof body.modelReady === "boolean" ||
    typeof body.readyForTraffic === "boolean" ||
    typeof body.status === "string" ||
    typeof body.modelState === "string" ||
    (body.error && typeof body.error === "object")
  );
}

/**
 * Normalize upstream `edunova-ai` health response into EduNova's consistent
 * status contract while preserving existing fields (`modelReady`, `modelState`,
 * `model`, `error`, `resource`) for backward compatibility.
 */
function normalizeUpstreamStatusPayload(body, upstreamHttpStatus, { internalAuthReady = true } = {}) {
  const dbReady = isDatabaseReady();

  if (!hasRecognizedHealthSchema(body)) {
    return {
      httpStatus: 502,
      payload: {
        success: false,
        status: "invalid_response",
        configured: true,
        provider: "edunova-ai",
        database: dbReady ? "connected" : "disconnected",
        modelReady: false,
        modelState: "INVALID_RESPONSE",
        capabilities: buildCapabilities({ chatReady: false, dbReady: false, researchReady: false }),
        errorCode: "INVALID_STATUS_RESPONSE",
        error: {
          code: "INVALID_STATUS_RESPONSE",
          message: "Unable to verify AI service status",
        },
        message: "Unable to verify AI service status",
      },
    };
  }

  const provider = inferUpstreamProviderName(body);
  const rawCode = String(
    body.error?.code || body.errorStage || body.model?.errorStage || ""
  ).trim();
  const rawState = String(
    body.modelState || body.model?.state || body.status || ""
  ).trim();
  const upperCode = rawCode.toUpperCase();
  const lowerState = rawState.toLowerCase();

  const upstreamReady =
    body.modelReady === true &&
    upstreamHttpStatus >= 200 &&
    upstreamHttpStatus < 400 &&
    !body.permanentFailure &&
    internalAuthReady;

  if (upstreamReady) {
    const researchReady = isResearchSupported(body);
    const capabilities = buildCapabilities({
      chatReady: true,
      dbReady,
      researchReady,
    });
    const allCoreCapabilities =
      capabilities.chat &&
      capabilities.timetable &&
      capabilities.subjects &&
      capabilities.quizAnalysis;
    const normalizedStatus = allCoreCapabilities ? "healthy" : "degraded";
    return {
      httpStatus: 200,
      payload: {
        ...body,
        success: true,
        status: normalizedStatus,
        configured: true,
        provider,
        database: dbReady ? "connected" : "disconnected",
        modelReady: true,
        modelState: body.modelState || "MODEL_READY",
        capabilities,
        ...(allCoreCapabilities
          ? {}
          : {
              degradedReason: !dbReady
                ? "Student database is currently disconnected; general AI chat remains available."
                : "Running with partial capabilities.",
            }),
      },
    };
  }

  const isConfigFailure =
    !internalAuthReady ||
    ["CONFIG_FAILED", "NOT_CONFIGURED", "AUTH_NOT_CONFIGURED"].includes(upperCode) ||
    lowerState === "not_configured" ||
    lowerState === "config_failed";

  if (isConfigFailure) {
    const message = !internalAuthReady
      ? "Internal AI service authentication is not configured"
      : sanitizeProviderError(
          body.error?.message || body.lastError || body.message,
          "AI service is not configured"
        );
    return {
      httpStatus: 503,
      payload: {
        ...body,
        success: false,
        status: "not_configured",
        configured: false,
        provider,
        database: dbReady ? "connected" : "disconnected",
        modelReady: false,
        modelState: body.modelState || "CONFIG_FAILED",
        capabilities: buildCapabilities({ chatReady: false, dbReady: false, researchReady: false }),
        error: {
          code: rawCode || "CONFIG_FAILED",
          message,
        },
        message,
      },
    };
  }

  const isWarming =
    !body.permanentFailure &&
    !body.model?.permanentFailure &&
    (["MODEL_NOT_READY", "MODEL_LOADING"].includes(upperCode) ||
      ["starting", "not_started", "cold", "boot", "model_not_ready", "model_loading", "downloading", "loading", "warming"].includes(lowerState));

  if (isWarming) {
    const message = sanitizeProviderError(
      body.error?.message || body.lastError || body.message,
      "AI assistant is starting up"
    );
    return {
      httpStatus: upstreamHttpStatus >= 400 ? upstreamHttpStatus : 503,
      payload: {
        ...body,
        success: false,
        status: "degraded",
        configured: true,
        provider,
        database: dbReady ? "connected" : "disconnected",
        modelReady: false,
        modelState: body.modelState || "starting",
        capabilities: buildCapabilities({ chatReady: false, dbReady, researchReady: false }),
        error: {
          code: rawCode || "MODEL_NOT_READY",
          message,
        },
        message,
      },
    };
  }

  const errCode =
    rawCode ||
    (upstreamHttpStatus === 401 || upstreamHttpStatus === 403
      ? "AUTH_FAILED"
      : upstreamHttpStatus === 429
        ? "MODEL_BUSY"
        : "AI_SERVICE_UNAVAILABLE");
  const errMessage = sanitizeProviderError(
    body.error?.message || body.lastError || body.detail?.message || body.detail || body.message,
    "AI service is temporarily unavailable"
  );

  return {
    httpStatus: upstreamHttpStatus >= 400 ? upstreamHttpStatus : 503,
    payload: {
      ...body,
      success: false,
      status: "unavailable",
      configured: true,
      provider,
      database: dbReady ? "connected" : "disconnected",
      modelReady: false,
      modelState: body.modelState || "MODEL_FAILED",
      capabilities: buildCapabilities({ chatReady: false, dbReady: false, researchReady: false }),
      error: {
        code: errCode,
        message: errMessage,
      },
      message: errMessage,
    },
  };
}

function buildDirectProviderHealth(directConfig) {
  const dbReady = isDatabaseReady();
  const researchReady = isResearchSupported();
  if (!directConfig || !directConfig.configured) {
    const msg = directConfig?.error || "AI service endpoint is not configured";
    return {
      httpStatus: 503,
      payload: {
        success: false,
        status: "not_configured",
        configured: false,
        provider: directConfig?.name || "unconfigured",
        database: dbReady ? "connected" : "disconnected",
        modelReady: false,
        modelState: "CONFIG_FAILED",
        capabilities: buildCapabilities({ chatReady: false, dbReady: false, researchReady: false }),
        errorCode: "CONFIG_FAILED",
        error: { code: "CONFIG_FAILED", message: msg },
        message: msg,
      },
    };
  }

  const capabilities = buildCapabilities({
    chatReady: true,
    dbReady,
    researchReady,
  });
  const healthy = capabilities.chat && capabilities.timetable && capabilities.subjects && capabilities.quizAnalysis;
  return {
    httpStatus: 200,
    payload: {
      success: true,
      status: healthy ? "healthy" : "degraded",
      configured: true,
      provider: directConfig.name,
      model: { id: directConfig.model, provider: directConfig.name, state: "MODEL_READY" },
      database: dbReady ? "connected" : "disconnected",
      modelReady: true,
      readyForTraffic: true,
      modelState: "MODEL_READY",
      capabilities,
      ...(healthy
        ? {}
        : {
            degradedReason:
              "Student database is currently disconnected; general AI chat remains available.",
          }),
    },
  };
}

// ---------------------------------------------------------------------------
// Intent & Context Classification for Direct Provider Execution
// ---------------------------------------------------------------------------

function extractSubject(message) {
  const lowered = String(message || "").toLowerCase();
  for (const subject of SUBJECT_LEXICON) {
    const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(lowered)) {
      return subject.length > 3
        ? subject.replace(/\b\w/g, (c) => c.toUpperCase())
        : subject;
    }
  }
  return undefined;
}

function classifyStudentIntent(message) {
  const text = String(message || "").trim();
  const lowered = text.toLowerCase();
  const subject = extractSubject(text);

  if (
    /\b(create|make|generate|prepare|plan|build|draft)\b[\s\S]{0,60}?\b(study plan|revision plan|study schedule|exam study plan|exam plan|preparation plan|revision schedule)\b/i.test(lowered) ||
    /\bexam study plan\b/i.test(lowered)
  ) {
    return {
      intent: "exam_study_plan",
      subject,
      tools: [
        "get_today_schedule",
        "get_timetable",
        "get_exams",
        "get_progress",
        "get_quiz_history",
        "get_assignments",
        "get_syllabus",
        "get_learning_documents",
      ],
    };
  }

  if (
    /\b(analy[sz]e|review|explain|check|inspect|break down|how did i do)\b[\s\S]{0,35}?\b(last|latest|recent|previous|my)?\s*(quiz|quizzes|attempt|attempts|test|scores?|results?)\b/i.test(lowered) ||
    /\b(last|latest|recent|previous)\s+quiz\b/i.test(lowered) ||
    /\b(weak|weakest|strong|strongest)\b[\s\S]{0,25}?\b(subjects?|topics?|areas?)\b/i.test(lowered) ||
    /\b(quiz (scores?|results?|history)|my performance|how am i (doing|performing))\b/i.test(lowered)
  ) {
    return {
      intent: "quiz_analysis",
      subject,
      tools: ["get_quiz_results", "get_quiz_history", "get_progress", "get_subjects"],
    };
  }

  if (
    /\bwhat should i study\b|\bwhat (to|shall i|do i) study\b|\bsuggest[\s\S]{0,25}?\bstudy\b|\bhow should i study today\b|\bplan my (day|studies today)\b/i.test(lowered)
  ) {
    return {
      intent: "study_recommendation",
      subject,
      tools: [
        "get_today_schedule",
        "get_progress",
        "get_quiz_history",
        "get_quiz_results",
        "get_assignments",
        "get_study_history",
        "get_exams",
        "get_syllabus",
      ],
    };
  }

  if (
    /\b(classes|class|periods?|schedule|timetable|lectures?)\b[\s\S]{0,30}?\b(today|upcoming|next|tomorrow|this week|monday|tuesday|wednesday|thursday|friday)\b/i.test(lowered) ||
    /\btoday'?s\b[\s\S]{0,30}?\b(classes|class|periods?|schedule|timetable|lectures?)\b/i.test(lowered) ||
    /\bwhat\b[\s\S]{0,20}?\b(classes|periods?)\b[\s\S]{0,20}?\bhave\b/i.test(lowered) ||
    /\bmy (timetable|schedule|upcoming classes)\b/i.test(lowered)
  ) {
    const weekdayMatch = lowered.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    return {
      intent: "timetable",
      subject,
      day: weekdayMatch ? weekdayMatch[1][0].toUpperCase() + weekdayMatch[1].slice(1).toLowerCase() : undefined,
      tools: ["get_today_schedule", "get_upcoming_classes", "get_timetable"],
    };
  }

  if (
    /\b(my subjects?|available subjects?|what subjects?|enrolled|my courses?|syllabus|curriculum|my progress|learning progress)\b/i.test(lowered)
  ) {
    return {
      intent: "subjects",
      subject,
      tools: ["get_subjects", "get_syllabus", "get_progress"],
    };
  }

  if (
    /\b(verified research|research papers?|scientific stud(y|ies)|peer[- ]reviewed|cite sources?|find sources?|latest research|recent advances|latest news|current developments|search the web|look up online)\b/i.test(lowered)
  ) {
    return {
      intent: "verified_research",
      subject,
      tools: [],
      useResearch: true,
    };
  }

  if (/\b(my|i)\b[\s\S]{0,25}?\b(exams?|assignments?|homework|attendance|notes|goals)\b/i.test(lowered)) {
    return {
      intent: "student_records",
      subject,
      tools: ["get_exams", "get_assignments", "get_attendance", "get_notes", "get_goals"],
    };
  }

  return {
    intent: "general_chat",
    subject,
    tools: [],
  };
}

// ---------------------------------------------------------------------------
// Verified External Research Retrieval (Real Sources Only — Never Fabricated)
// ---------------------------------------------------------------------------

function normalizePublicHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchVerifiedResearchSources(query, maxResults = 5) {
  const cleanQuery = String(query || "")
    .replace(/^(please\s+)?(find|search|show|give me|cite)\s+(verified\s+)?(research|sources?|papers?|studies)\s+(on|about|for)\s+/i, "")
    .trim()
    .slice(0, 240);
  if (!cleanQuery) return [];

  const collected = [];
  const pushSource = (item) => {
    const safeUrl = normalizePublicHttpUrl(item.url);
    if (!safeUrl || collected.some((s) => s.url === safeUrl)) return;
    let domain = "";
    try {
      domain = new URL(safeUrl).hostname;
    } catch {
      domain = "";
    }
    collected.push({
      id: `S${collected.length + 1}`,
      title: String(item.title || domain || "External Source").replace(/\s+/g, " ").trim().slice(0, 240),
      url: safeUrl,
      domain,
      snippet: String(item.snippet || "").replace(/\s+/g, " ").trim().slice(0, 600),
      publishedDate: item.publishedDate || null,
      sourceType: "external",
    });
  };

  // 1) Configured commercial search API if present
  const searchKey = stripQuotes(process.env.WEB_SEARCH_API_KEY);
  const provider = String(process.env.WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
  if (searchKey && ["brave", "auto"].includes(provider)) {
    try {
      const res = await axios.get("https://api.search.brave.com/res/v1/web/search", {
        headers: { Accept: "application/json", "X-Subscription-Token": searchKey },
        params: { q: cleanQuery, count: maxResults, safesearch: "moderate" },
        timeout: 8000,
      });
      for (const row of res.data?.web?.results || []) {
        pushSource({ title: row.title, url: row.url, snippet: row.description, publishedDate: row.age });
        if (collected.length >= maxResults) return collected;
      }
    } catch {
      // Fall through to public scholarly/reference indexes.
    }
  }

  // 2) CrossRef scholarly index (peer-reviewed DOIs)
  try {
    const cr = await axios.get("https://api.crossref.org/works", {
      params: { query: cleanQuery, rows: Math.min(3, maxResults) },
      headers: { "User-Agent": "EduNovaAI/1.0 (https://edunova-x.ranjitacharya13.workers.dev)" },
      timeout: 7000,
    });
    for (const item of cr.data?.message?.items || []) {
      const title = Array.isArray(item.title) ? item.title[0] : item.title;
      const url = item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : "");
      const year = item.issued?.["date-parts"]?.[0]?.[0];
      const container = Array.isArray(item["container-title"]) ? item["container-title"][0] : "";
      if (title && url) {
        pushSource({
          title,
          url,
          snippet: [container, item.DOI ? `DOI: ${item.DOI}` : ""].filter(Boolean).join(" · "),
          publishedDate: year ? String(year) : null,
        });
        if (collected.length >= maxResults) return collected;
      }
    }
  } catch {
    // Optional public index unreachable in restricted networks.
  }

  // 3) Wikipedia reference search
  try {
    const wiki = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: {
        action: "query",
        list: "search",
        srsearch: cleanQuery,
        srlimit: Math.min(3, maxResults),
        format: "json",
      },
      headers: { "User-Agent": "EduNovaAI/1.0" },
      timeout: 7000,
    });
    for (const row of wiki.data?.query?.search || []) {
      const snippet = String(row.snippet || "").replace(/<[^>]*>/g, " ");
      pushSource({
        title: `${row.title} — Wikipedia`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(row.title || "").replace(/ /g, "_"))}`,
        snippet,
      });
      if (collected.length >= maxResults) return collected;
    }
  } catch {
    // Optional public index unreachable in restricted networks.
  }

  // 4) GitHub public repositories index (for CS/programming/engineering research)
  if (collected.length < maxResults) {
    try {
      const gh = await axios.get("https://api.github.com/search/repositories", {
        params: { q: cleanQuery.slice(0, 200), per_page: Math.min(3, maxResults - collected.length) },
        headers: { Accept: "application/vnd.github+json", "User-Agent": "EduNovaAI/1.0" },
        timeout: 7000,
      });
      for (const repo of gh.data?.items || []) {
        pushSource({
          title: repo.full_name,
          url: repo.html_url,
          snippet: repo.description || "Public open-source repository and documentation",
          publishedDate: repo.updated_at ? String(repo.updated_at).slice(0, 10) : null,
        });
        if (collected.length >= maxResults) break;
      }
    } catch {
      // No external source reachable.
    }
  }

  return collected;
}

function enforceCitationIntegrity(answerText, sources) {
  const validIds = new Set((sources || []).map((s) => s.id));
  return String(answerText || "")
    .replace(/\[S(\d+)\]/g, (match, num) => (validIds.has(`S${num}`) ? match : ""))
    .trim();
}

// ---------------------------------------------------------------------------
// Per-User Scoped Conversation Memory
// ---------------------------------------------------------------------------

function getConversationHistory(userId, conversationId) {
  if (!conversationId) return [];
  const key = `${userId}:${conversationId}`;
  const entry = conversationStore.get(key);
  if (!entry) return [];
  if (entry.expiresAt < Date.now()) {
    conversationStore.delete(key);
    return [];
  }
  return entry.turns.slice(-MAX_CONVERSATION_TURNS * 2);
}

function appendConversationTurn(userId, conversationId, userMessage, assistantMessage) {
  if (!conversationId) return;
  for (const [k, v] of conversationStore.entries()) {
    if (v.expiresAt < Date.now()) conversationStore.delete(k);
  }
  if (conversationStore.size >= MAX_CONVERSATIONS) {
    const oldestKey = conversationStore.keys().next().value;
    if (oldestKey) conversationStore.delete(oldestKey);
  }
  const key = `${userId}:${conversationId}`;
  const existing = conversationStore.get(key)?.turns || [];
  const updated = [
    ...existing,
    { role: "user", content: String(userMessage || "").slice(0, 2000) },
    { role: "assistant", content: String(assistantMessage || "").slice(0, 4000) },
  ].slice(-MAX_CONVERSATION_TURNS * 2);
  conversationStore.set(key, {
    turns: updated,
    expiresAt: Date.now() + CONVERSATION_TTL_MS,
  });
}

// ---------------------------------------------------------------------------
// OpenAI-Compatible Provider Invocation & Query Execution
// ---------------------------------------------------------------------------

async function callOpenAICompatible(providerConfig, messages, { maxTokens = 900, temperature = 0.2 } = {}) {
  try {
    const response = await axios.post(
      `${providerConfig.baseUrl}/chat/completions`,
      {
        model: providerConfig.model,
        messages,
        max_tokens: maxTokens,
        temperature,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerConfig.apiKey}`,
        },
        timeout: providerConfig.timeoutMs,
        validateStatus: () => true,
      }
    );

    if (response.status >= 400) {
      const rawMsg =
        response.data?.error?.message ||
        response.data?.detail ||
        response.data?.message ||
        (typeof response.data === "string" ? response.data : "");
      const code =
        response.status === 401 || response.status === 403
          ? "PROVIDER_AUTH_FAILED"
          : response.status === 429
            ? "RATE_LIMITED"
            : "PROVIDER_UNAVAILABLE";
      const err = new Error(
        sanitizeProviderError(rawMsg, `AI provider returned HTTP ${response.status}`)
      );
      err.status = response.status === 429 ? 429 : 503;
      err.code = code;
      throw err;
    }

    const choice = response.data?.choices?.[0]?.message?.content;
    const content = Array.isArray(choice)
      ? choice.map((part) => (typeof part === "string" ? part : part?.text || "")).join("")
      : String(choice || "");

    if (!content.trim()) {
      const err = new Error("AI provider returned an empty response");
      err.status = 502;
      err.code = "INVALID_MODEL_OUTPUT";
      throw err;
    }

    return content.trim();
  } catch (err) {
    if (err.code && err.status) throw err;
    const isTimeout = err.code === "ECONNABORTED" || /timeout/i.test(String(err.message));
    const wrapped = new Error(
      isTimeout
        ? "AI provider request timed out. Please try again."
        : "AI provider is temporarily unavailable."
    );
    wrapped.status = isTimeout ? 504 : 503;
    wrapped.code = isTimeout ? "UPSTREAM_TIMEOUT" : "PROVIDER_UNAVAILABLE";
    throw wrapped;
  }
}

/**
 * Execute an authenticated student query using the configured direct
 * OpenAI-compatible provider + EduNova's in-process ApplicationToolRegistry.
 */
async function executeDirectAssistantQuery({
  providerConfig,
  user,
  message,
  conversationId,
  applicationContext,
  onEvent,
}) {
  const userId = String(user.id || user._id);
  const convId =
    conversationId && /^[a-zA-Z0-9_-]{8,80}$/.test(conversationId)
      ? conversationId
      : `conv_${crypto.randomUUID().replace(/-/g, "")}`;

  await onEvent?.({
    type: "status",
    event: "agent.started",
    message: "Understanding your question...",
  });

  const route = classifyStudentIntent(message);
  const internalSources = [];
  const actions = [];
  const dbFacts = {};
  let usedInternalDb = false;

  if (route.tools.length > 0) {
    await onEvent?.({
      type: "status",
      event: "agent.tool_started",
      message: "Checking your EduNova records...",
    });

    for (const toolName of route.tools) {
      const toolArgs = {};
      if (route.subject && ["get_syllabus", "get_progress", "get_quiz_history", "get_quiz_results", "get_exams"].includes(toolName)) {
        toolArgs.subject = route.subject;
      }
      if (route.day && toolName === "get_timetable") {
        toolArgs.day = route.day;
      }

      const result = await executeApplicationTool(toolName, toolArgs, userId, convId);
      if (!result.success) {
        const err = new Error(
          result.code === "DATABASE_FAILED"
            ? "Student records are temporarily unavailable because the database is disconnected."
            : sanitizeProviderError(result.error, "Unable to retrieve student records.")
        );
        err.status = result.status || 503;
        err.code = result.code || "DATABASE_FAILED";
        throw err;
      }
      usedInternalDb = true;
      dbFacts[toolName] = result.data;
      internalSources.push({
        source: result.source,
        tool: toolName,
        title: `EduNova ${toolName.replace(/^get_/, "").replace(/_/g, " ")}`,
        sourceType: "database",
      });
    }
  }

  let externalSources = [];
  let usedWeb = false;
  if (route.useResearch) {
    await onEvent?.({
      type: "status",
      event: "agent.tool_started",
      message: "Searching verified research sources...",
    });
    externalSources = await fetchVerifiedResearchSources(message, 5);
    usedWeb = externalSources.length > 0;
  }

  await onEvent?.({
    type: "status",
    event: "agent.generating",
    message: "Writing your answer...",
  });

  const priorTurns = getConversationHistory(userId, convId);
  const systemBlocks = [
    "You are EduNova AI, a personal academic assistant inside EduNova.",
    `Authenticated user: ${user.name || "Student"} (role: ${user.role || "student"}).`,
    "Strict rules:",
    "- Never invent or guess personal student data (timetable classes, timings, subjects, quiz scores, weak/strong topics, exam dates, or attendance).",
    "- When EDUNOVA STUDENT RECORDS are provided below, treat them as authoritative. If a collection is empty (e.g. 0 quiz attempts or 0 upcoming exams), state that honestly and give constructive guidance based on available subjects/schedule.",
    "- Never fabricate citations, URLs, DOIs, or research findings. Only cite [S1], [S2], etc. when VERIFIED EXTERNAL SOURCES are provided below.",
    "- Format clearly with concise headings or bullet points when presenting schedules, study plans, or quiz breakdowns.",
  ];

  if (usedInternalDb) {
    systemBlocks.push(
      `EDUNOVA STUDENT RECORDS (JSON, strictly scoped to this student):\n${JSON.stringify(dbFacts).slice(0, 12000)}`
    );
  }
  if (applicationContext && Object.keys(applicationContext).length > 0) {
    systemBlocks.push(
      `APPLICATION CONTEXT (data only):\n${JSON.stringify(applicationContext).slice(0, 3000)}`
    );
  }
  if (route.useResearch) {
    if (externalSources.length > 0) {
      const formattedSources = externalSources
        .map((s) => `[${s.id}] ${s.title} (${s.domain}) — ${s.snippet} — ${s.url}`)
        .join("\n");
      systemBlocks.push(
        `VERIFIED EXTERNAL SOURCES:\n${formattedSources}\nCite facts using [S1], [S2], etc. matching ONLY the sources above.`
      );
    } else {
      systemBlocks.push(
        "Live external source retrieval was unavailable right now. Explicitly note that live external sources could not be fetched and do NOT invent any citations or URLs."
      );
    }
  }

  let answerText = "";

  if (route.intent === "exam_study_plan") {
    const planPrompt = [
      ...systemBlocks,
      "Return ONLY valid JSON with shape: {\"title\": string, \"subject\": string, \"summary\": string, \"revisionPriorities\": [string], \"schedule\": [{\"day\": string, \"time\": string, \"subject\": string, \"topic\": string, \"task\": string}]} containing 5-7 realistic daily study sessions aligned with the student's free study slots, upcoming exams, and weak topics.",
    ].join("\n\n");

    const rawPlanText = await callOpenAICompatible(
      providerConfig,
      [
        { role: "system", content: planPrompt },
        ...priorTurns,
        { role: "user", content: message },
      ],
      { maxTokens: 1100, temperature: 0.2 }
    );

    let parsedPlan = null;
    try {
      const jsonMatch = rawPlanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsedPlan = JSON.parse(jsonMatch[0]);
    } catch {
      parsedPlan = null;
    }

    if (
      parsedPlan &&
      typeof parsedPlan.title === "string" &&
      Array.isArray(parsedPlan.schedule) &&
      parsedPlan.schedule.length > 0
    ) {
      const cleanSchedule = parsedPlan.schedule
        .filter((item) => item && item.day && item.topic)
        .slice(0, 14)
        .map((item) => ({
          day: String(item.day).trim().slice(0, 80),
          time: String(item.time || "16:30 - 18:00").trim().slice(0, 80),
          subject: String(item.subject || parsedPlan.subject || "General Revision").trim().slice(0, 100),
          topic: String(item.topic).trim().slice(0, 200),
          task: String(item.task || "Focused concept review & practice questions").trim().slice(0, 300),
        }));

      if (cleanSchedule.length > 0) {
        const planAction = await executeApplicationTool(
          "create_study_plan",
          {
            title: parsedPlan.title.trim().slice(0, 180) || "Personalized Exam Study Plan",
            subject: String(parsedPlan.subject || route.subject || "All Subjects").trim().slice(0, 100),
            schedule: cleanSchedule,
          },
          userId,
          convId
        );
        if (planAction.success && planAction.data) {
          actions.push({
            tool: "create_study_plan",
            action: "create_study_plan",
            message: planAction.data.message || "Confirm to save study plan to EduNova.",
            data: planAction.data,
          });
        }

        const prioritiesBlock =
          Array.isArray(parsedPlan.revisionPriorities) && parsedPlan.revisionPriorities.length
            ? `\n**Revision Priorities**\n${parsedPlan.revisionPriorities.map((p) => `- ${p}`).join("\n")}\n`
            : "";
        const scheduleLines = cleanSchedule
          .map((s) => `- **${s.day} (${s.time})** — *${s.subject}*: ${s.topic} — ${s.task}`)
          .join("\n");

        answerText = [
          `**${parsedPlan.title.trim()}**`,
          parsedPlan.summary ? String(parsedPlan.summary).trim() : "",
          prioritiesBlock.trim(),
          `**Daily Study Schedule**\n${scheduleLines}`,
          planAction.data?.requiresConfirmation
            ? "Confirm below to save this study plan to your EduNova planner."
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    }

    if (!answerText) {
      answerText = rawPlanText;
    }
  } else {
    const rawAnswer = await callOpenAICompatible(
      providerConfig,
      [
        { role: "system", content: systemBlocks.join("\n\n") },
        ...priorTurns,
        { role: "user", content: message },
      ],
      { maxTokens: 950, temperature: 0.2 }
    );
    answerText = enforceCitationIntegrity(rawAnswer, externalSources);
  }

  appendConversationTurn(userId, convId, message, answerText);

  await onEvent?.({
    type: "token",
    delta: answerText,
  });

  return {
    type: "answer",
    success: true,
    message: answerText,
    reply: answerText,
    sources: externalSources,
    internalSources,
    actions,
    usedWeb,
    usedInternalDb,
    agentStatus: "completed",
    conversationId: convId,
    limitReached: false,
  };
}

module.exports = {
  resolveDirectProviderConfig,
  normalizeUpstreamStatusPayload,
  buildDirectProviderHealth,
  buildCapabilities,
  isDatabaseReady,
  isResearchSupported,
  classifyStudentIntent,
  executeDirectAssistantQuery,
  sanitizeProviderError,
};
