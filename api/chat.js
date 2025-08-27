import { MOCK_CHAT_REPLY } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;
  const MOCK = (process.env.MOCK || "true") === "true";
  const { message = "", userProfile = {}, conversationId = null } = req.body || {};
  if (!message) return res.status(400).json({ error: "Message is required" });
  if (MOCK) return res.json({ reply: MOCK_CHAT_REPLY.reply, suggestedActions: MOCK_CHAT_REPLY.suggestedActions, caution: MOCK_CHAT_REPLY.caution, mode: "mock" });
  if (!OPENAI_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set" });
  const systemPrompt = `You are a friendly registered dietitian and nutrition coach. Provide clear, evidence-based guidance but never give medical diagnoses. Always ask clarifying questions if needed.`;
  try {
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.2,
        max_tokens: 600
      })
    });
    const openaiData = await openaiResp.json();
    const text = openaiData?.choices?.[0]?.message?.content || "Sorry, I couldn't generate a reply.";
    return res.json({ reply: text });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "Chat failed", details: String(err) });
  }
}
