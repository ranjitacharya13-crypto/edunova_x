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

    const aiBaseUrl = process.env.AI_ENGINE_URL || "http://localhost:8000";
    const aiResponse = await axios.post(
      `${aiBaseUrl}/ai/query`,
      {
        message: cleanMessage,
        email: cleanEmail,
      },
      {
        timeout: 15000,
      }
    );

    return res.json(aiResponse.data);
  } catch (error) {
    const status = error.response?.status || 500;
    return res.status(status).json({
      error: error.response?.data?.detail || "AI service unavailable",
    });
  }
});

module.exports = router;
