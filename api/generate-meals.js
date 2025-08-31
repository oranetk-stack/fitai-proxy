// api/generate-meals.js
import { MOCK_RECIPES } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;

// Helper: safe JSON parse attempt
function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text && text.match(/\{[\s\S]*\}$/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// MOCK feature flag: set MOCK="true" in Vercel to enable canned responses.
// Default: real mode (when MOCK is not "true").
const MOCK = process.env.MOCK === "true";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;

  const { ingredients = [], diet = "none", calorieTarget = null, servings = 1, userProfile = {} } =
    req.body || {};

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: "Please provide an ingredients array in the request body." });
  }

  // If MOCK flag set to "true", return canned mock data for safety/testing.
  if (MOCK) {
    return res.json({
      recipes: MOCK_RECIPES,
      notes: "mock mode",
      input: { ingredients, diet, calorieTarget, servings }
    });
  }

  // ---------- REAL MODE ----------
  if (!OPENAI_KEY) {
    console.error("OPENAI_API_KEY missing in environment");
    return res.status(500).json({ error: "Server misconfigured: missing OPENAI_API_KEY" });
  }

  const systemPrompt = `You are an expert chef and registered dietitian. Given pantry ingredients and user constraints, respond ONLY with valid JSON.
Top-level: { "recipes": [ ... ] }
Each recipe must include:
- title (string)
- description (string)
- ingredients (array of { "name": string, "quantity": string })
- steps (array of strings)
- estimatedCalories (number)
- macros { protein:number, carbs:number, fat:number }
Return up to 3 recipes. Do NOT include any extra text, markdown, or commentary.`;

  const userPrompt = `Ingredients: ${ingredients.join(", ")}
Diet: ${diet}
Calorie target: ${calorieTarget || "none"}
Servings: ${servings}
UserProfile: ${JSON.stringify(userProfile)}`;

  try {
    // Call OpenAI Chat Completions
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 1200
      })
    });

    const openaiData = await openaiResp.json();
    const text = openaiData?.choices?.[0]?.message?.content;
    const parsed = safeParseJson(text);

    if (!parsed || !Array.isArray(parsed.recipes)) {
      console.error("OpenAI returned non-JSON or unexpected format", { openaiData });
      return res.status(502).json({ error: "AI returned unexpected format", details: openaiData?.error || "parsing failed" });
    }

    // If Spoonacular is available, enrich recipes (best-effort). Do not fail hard if it errors.
    if (SPOONACULAR_KEY) {
      const recipesWithNutrition = [];
      for (const r of parsed.recipes) {
        try {
          // Prepare ingredient lines (quantity + name) for Spoonacular parsing
          const ingrList = (r.ingredients || [])
            .map(i => `${i.quantity || ""} ${i.name || ""}`.trim())
            .filter(Boolean)
            .join("\n");

          // Use application/x-www-form-urlencoded so Spoonacular receives 'ingredientList' as a form param
          const form = new URLSearchParams();
          form.append("ingredientList", ingrList);

          const spoonRes = await fetch(
            `https://api.spoonacular.com/recipes/parseIngredients?apiKey=${SPOONACULAR_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: form.toString()
            }
          );

          let spoonJson = null;
          if (spoonRes.ok) {
            spoonJson = await spoonRes.json();
          } else {
            const textErr = await spoonRes.text();
            console.warn("Spoonacular parseIngredients failed:", spoonRes.status, textErr);
            spoonJson = { status: "failure", code: spoonRes.status, message: textErr };
          }

          r.spoonacular = spoonJson || null;
          r.source = r.source || "openai+spoonacular";
        } catch (err) {
          console.warn("Spoonacular parse failed:", err);
          r.source = r.source || "openai";
          r.spoonacular = { status: "failure", message: String(err) };
        }
        recipesWithNutrition.push(r);
      }
      return res.json({ recipes: recipesWithNutrition });
    }

    // No Spoonacular configured: return OpenAI recipes and mark source
    parsed.recipes.forEach(r => { r.source = r.source || "openai"; });
    return res.json({ recipes: parsed.recipes });
  } catch (err) {
    console.error("generate-meals error", err);
    return res.status(500).json({ error: "Internal server error", details: String(err) });
  }
}
