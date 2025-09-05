// api/generate-meals.js  (temporary debug-only version)
// Replace your current file with this to confirm Vercel function runtime is healthy.
// This handler intentionally avoids external imports and network calls.

export default function handler(req, res) {
  // quick debug URL: GET /api/generate-meals?debug=true
  if (req.method === "GET" && req.query && req.query.debug === "true") {
    return res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      env: {
        OPENAI_key_present: !!process.env.OPENAI_API_KEY,
        SPOONACULAR_key_present: !!process.env.SPOONACULAR_KEY,
        UPSTASH_present: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
        MOCK: process.env.MOCK || null,
      }
    });
  }

  // For any other request, return a clear message (won't call OpenAI)
  return res.status(200).json({
    message: "Debug handler installed. Use GET ?debug=true to check env presence.",
  });
}
