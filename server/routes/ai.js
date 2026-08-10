const express = require("express");
const axios = require("axios");

const router = express.Router();

router.post("/query", async (req, res) => {
  try {
    const { message, email } = req.body || {};

    const cleanMessage = String(message || "").trim();
    const cleanEmail = String(email || "").trim();

    if (!cleanMessage || !cleanEmail) {
      return res.status(400).json({
        error: "Both message and email are required",
      });
    }

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
      aiResponse = await axios.post(`${aiBaseUrl}/ai/query`, payload, requestOptions);
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

    const status = error.response?.status || 500;
    console.error("[ai] AI engine error:", error.response?.data || error.message);
    return res.status(status).json({
      error: error.response?.data?.detail || "AI service unavailable",
    });
  }
});

module.exports = router;
