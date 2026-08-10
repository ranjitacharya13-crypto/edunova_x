const express = require("express");
const axios = require("axios");

const router = express.Router();

router.post("/query", async (req, res) => {
  try {
    const { message, email } = req.body || {};

    const cleanMessage = String(message || "").trim();
    const cleanEmail = String(email || "").trim();

    if (!cleanMessage) {
      return res.status(400).json({ error: "A message is required" });
    }
    // The AI engine accepts an omitted email and treats it as a student query.
    // This avoids coupling the assistant to an optional profile field.

    // The AI engine is a SEPARATE deployment. In production it must be reached
    // over its public HTTPS URL — never 127.0.0.1/localhost, which on Render
    // would point back at this container and hang until timeout.
    const configuredAiUrl = String(process.env.AI_ENGINE_URL || "").trim();

    if (!configuredAiUrl) {
      if (process.env.NODE_ENV === "production") {
        // Degrade gracefully with a clear, actionable message rather than
        // silently dialing localhost and stalling the request for 15s.
        return res.status(503).json({
          error:
            "AI service is not configured. Set AI_ENGINE_URL on the API service " +
            "to the public URL of the deployed FastAPI AI engine.",
        });
      }
      console.warn(
        "[ai] AI_ENGINE_URL is not set — falling back to http://localhost:8001 (development only)."
      );
    }

    // Normalize: a scheme-less hostname (e.g. "my-ai.onrender.com") gets https://
    // so the request always goes over the public URL, never a relative path.
    let aiBaseUrl = (configuredAiUrl || "http://localhost:8001")
      .trim()
      .replace(/\/+$/, "");
    if (aiBaseUrl && !/^https?:\/\//i.test(aiBaseUrl)) {
      aiBaseUrl = `https://${aiBaseUrl}`;
    }
    const payload = {
      message: cleanMessage,
      email: cleanEmail,
    };
    const requestOptions = {
      timeout: 15000,
    };

    let aiResponse;
    try {
      aiResponse = await axios.post(`${aiBaseUrl}/api/ai/query`, payload, requestOptions);
    } catch (firstErr) {
      // Only use the legacy endpoint when the current endpoint is absent.
      // Retrying a provider 502/503 at a different path masks the root cause
      // and unnecessarily doubles latency during an outage.
      if (firstErr.response?.status !== 404) throw firstErr;
      aiResponse = await axios.post(`${aiBaseUrl}/ai/query`, payload, requestOptions);
    }

    if (!aiResponse.data?.success || !aiResponse.data?.reply) {
      console.error("[ai] AI engine returned an invalid response");
      return res.status(502).json({ error: "AI service temporarily unavailable" });
    }
    return res.json(aiResponse.data);
  } catch (error) {
    // Distinguish "AI service is down/unreachable" (503) from a real error the
    // AI service itself returned, so the frontend can show a useful message.
    const isUnreachable =
      !error.response &&
      ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(
        error.code
      );

    if (isUnreachable) {
      console.error(`[ai] AI engine unreachable (${error.code}):`, error.message);
      return res.status(503).json({
        error:
          "AI service is temporarily unavailable. It may be starting up — please try again shortly.",
      });
    }

    // Provider errors are never passed through to students: provider HTML,
    // stack traces, and infrastructure details are not part of our API contract.
    const upstreamStatus = error.response?.status;
    console.error(`[ai] AI engine request failed (upstream ${upstreamStatus || "network"}):`, error.message);
    return res.status(502).json({
      success: false,
      error: "AI service temporarily unavailable",
    });
  }
});

module.exports = router;
