import { MOCK_BARCODE } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";

const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;
  const MOCK = (process.env.MOCK || "true") === "true";
  const { barcode } = req.body || {};
  if (!barcode) return res.status(400).json({ error: "barcode required in body" });
  if (MOCK) return res.json({ product: MOCK_BARCODE, mode: "mock" });
  if (!SPOONACULAR_KEY) return res.status(500).json({ error: "SPOONACULAR_KEY not set" });
  try {
    const url = `https://api.spoonacular.com/food/products/upc/${barcode}?apiKey=${SPOONACULAR_KEY}`;
    const r = await fetch(url);
    const json = await r.json();
    return res.json({ product: json });
  } catch (err) {
    console.error("barcode error:", err);
    return res.status(500).json({ error: "Barcode lookup failed", details: String(err) });
  }
}
