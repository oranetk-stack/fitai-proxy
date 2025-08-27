import { MOCK_PARSED_ITEMS } from "../lib/mockData.js";
import { requireProxyKey, extractBase64 } from "../lib/utils.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;
  const MOCK = (process.env.MOCK || "true") === "true";
  const body = req.body;
  const imageBase64 = extractBase64(body?.imageBase64 || body?.image);
  if (!imageBase64) {
    return res.status(400).json({ error: "Missing imageBase64 in request body" });
  }
  if (MOCK) {
    return res.json({
      items: MOCK_PARSED_ITEMS,
      rawVisionData: null,
      confidenceSummary: "high",
      mode: "mock"
    });
  }
  return res.status(501).json({
    error: "Not implemented in real mode. Please add code to call Google Vision or OpenAI Vision in api/parse-image.js.",
    hint: "Set MOCK=false and implement Vision API logic in this file."
  });
}
