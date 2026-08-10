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
        success: false,
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
          success: false,
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
      timeout: 20000,
      headers: {
        "Content-Type": "application/json",
      },
    };

    let aiResponse;
    let lastError;

    // Try the canonical endpoint first (/api/ai/query), then the legacy
    // endpoint (/ai/query) as a fallback. Both are valid paths depending on
    // how the AI engine is deployed.
    const endpoints = ["/api/ai/query", "/ai/query"];

    for (const endpoint of endpoints) {
      try {
        aiResponse = await axios.post(
          `${aiBaseUrl}${endpoint}`,
          payload,
          requestOptions
        );
        break; // Success — stop trying endpoints
      } catch (err) {
        lastError = err;
        // If we got a response (even an error one), the service is reachable.
        // Only try the next endpoint for network-level failures or 404s.
        if (err.response && err.response.status !== 404) {
          // The AI engine is reachable but returned an error — don't try
          // the next endpoint, just report the error.
          break;
        }
      }
    }

    if (!aiResponse) {
      // All endpoints failed
      throw lastError || new Error("AI engine did not respond");
    }

    // Forward the AI engine's response directly. The AI engine returns
    // { success, reply, ... } which the frontend expects.
    return res.json(aiResponse.data);
  } catch (error) {
    // Distinguish "AI service is down/unreachable" (503) from a real error the
    // AI service itself returned, so the frontend can show a useful message.
    const isUnreachable =
      !error.response &&
      [
        "ECONNREFUSED",
        "ENOTFOUND",
        "ETIMEDOUT",
        "ECONNABORTED",
        "EAI_AGAIN",
        "ECONNRESET",
        "EHOSTUNREACH",
        "ERR_NETWORK",
      ].includes(error.code);

    if (isUnreachable) {
      console.error(
        `[ai] AI engine unreachable (${error.code}): ${error.message}`
      );
      return res.status(503).json({
        success: false,
        error:
          "AI service is temporarily unavailable. It may be starting up — please try again shortly.",
      });
    }

    // If the AI engine returned a response, forward its status and body.
    if (error.response) {
      const status = error.response.status || 500;
      console.error(
        `[ai] AI engine returned ${status}:`,
        error.response.data || error.message
      );
      return res.status(status >= 400 && status < 600 ? status : 502).json({
        success: false,
        error:
          error.response.data?.detail ||
          error.response.data?.error ||
          "AI service returned an error",
      });
    }

    // Catch-all for unexpected errors
    console.error("[ai] Unexpected AI route error:", error.message);
    return res.status(502).json({
      success: false,
      error: "AI service temporarily unavailable. Please try again.",
    });
  }
});

module.exports = router;
