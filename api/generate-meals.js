// api/generate-meals.js
import { MOCK_RECIPES } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 86400); // 24h default

// ---------------------- Simple in-memory cache ----------------------
// Note: In serverless environments this cache is ephemeral (per instance).
// It still helps during warm instances and spikes. For persistent cross-instance
// caching, use Vercel KV / Upstash Redis (see notes below).
const ingredientInfoCache = new Map(); // key -> { value, expiresAt (ms) }

function cacheGet(key) {
  const e = ingredientInfoCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    ingredientInfoCache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  ingredientInfoCache.set(key, { value, expiresAt });
}

// ---------------------- Helpers ----------------------
function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text && text.match(/\{[\s\S]*\}$/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch (e2) { return null; }
    }
    return null;
  }
}

function nutrientKey(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("calorie")) return "calories";
  if (n.includes("protein")) return "protein";
  if (n.includes("fat")) return "fat";
  if (n.includes("carb")) return "carbs";
  return null;
}

const MOCK = process.env.MOCK === "true";

// Optional: placeholder to plug in persistent cache (Upstash / Redis / Vercel KV)
// If you add a persistent cache, implement getIngredientInfoFromPersistentCache() and use it.
// Example env var: PERSISTENT_CACHE_PROVIDER=upstash and UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN.
async function getIngredientInfoFromSpoonacularCached(id, amount, unit) {
  // create a stable cache key
  const key = `${id}|${amount}|${unit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Fetch from Spoonacular
  try {
    const infoUrl = new URL(`https://api.spoonacular.com/food/ingredients/${id}/information`);
    infoUrl.searchParams.set("apiKey", SPOONACULAR_KEY);
    infoUrl.searchParams.set("amount", String(amount));
    infoUrl.searchParams.set("unit", String(unit));

    const infoRes = await fetch(infoUrl.toString(), { method: "GET" });
    if (!infoRes.ok) {
      const txt = await infoRes.text();
      console.warn("Ingredient information fetch failed:", infoRes.status, txt);
      // cache the failure response for a short time to avoid tight retry loops
      const failureObj = { error: true, status: infoRes.status, text: txt };
      cacheSet(key, failureObj, 60); // short TTL for failures
      return failureObj;
    }

    const infoJson = await infoRes.json();
    cacheSet(key, infoJson, CACHE_TTL_SECONDS);
    return infoJson;
  } catch (err) {
    console.warn("Ingredient info fetch error:", err);
    const failureObj = { error: true, message: String(err) };
    cacheSet(key, failureObj, 60);
    return failureObj;
  }
}

// -------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;

  const { ingredients = [], diet = "none", calorieTarget = null, servings = 1, userProfile = {} } = req.body || {};
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: "Please provide an ingredients array in the request body." });
  }

  if (MOCK) {
    return res.json({
      recipes: MOCK_RECIPES,
      notes: "mock mode",
      input: { ingredients, diet, calorieTarget, servings }
    });
  }

  if (!OPENAI_KEY) {
    console.error("OPENAI_API_KEY missing in environment");
    return res.status(500).json({ error: "Server misconfigured: missing OPENAI_API_KEY" });
  }

  // Build prompts
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
    // 1) Ask OpenAI for recipes
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

    // 2) If Spoonacular configured -> parse & compute nutrition with caching
    if (SPOONACULAR_KEY) {
      const recipesWithNutrition = [];

      for (const r of parsed.recipes) {
        let nutritionTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        let nutritionSource = null;

        try {
          const ingrList = (r.ingredients || [])
            .map(i => `${i.quantity || ""} ${i.name || ""}`.trim())
            .filter(Boolean)
            .join("\n");

          // parseIngredients: form-encoded (we did this earlier)
          const form = new URLSearchParams();
          form.append("ingredientList", ingrList);

          const spoonParseRes = await fetch(
            `https://api.spoonacular.com/recipes/parseIngredients?apiKey=${SPOONACULAR_KEY}`,
            { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }
          );

          let spoonParsed = null;
          if (spoonParseRes.ok) {
            spoonParsed = await spoonParseRes.json();
          } else {
            const txt = await spoonParseRes.text();
            console.warn("Spoonacular parseIngredients failed:", spoonParseRes.status, txt);
            spoonParsed = null;
          }

          if (Array.isArray(spoonParsed) && spoonParsed.length > 0) {
            // For each parsed ingredient, fetch ingredient info (cached)
            for (const p of spoonParsed) {
              try {
                const id = p.id;
                const amount = p.amount;
                let unit = p.unit || p.unitShort || p.unitString || "";

                if (!id || !amount || !unit) {
                  continue; // skip if not enough info
                }

                // Attempt to get cached ingredient info
                const info = await getIngredientInfoFromSpoonacularCached(id, amount, unit);

                if (info && !info.error) {
                  const nutrients = info?.nutrition?.nutrients || [];
                  for (const nutrient of nutrients) {
                    const key = nutrientKey(nutrient?.name || nutrient?.title || "");
                    if (!key) continue;
                    const value = Number(nutrient.amount) || 0;
                    nutritionTotals[key] = (nutritionTotals[key] || 0) + value;
                  }
                }
                // attach spoonParsed raw info to recipe for inspection
                r.spoonacular = spoonParsed;
              } catch (perIngErr) {
                console.warn("Error computing ingredient nutrition:", perIngErr);
              }
            } // end for each parsed ingredient

            const anyTotal = (nutritionTotals.calories || 0) + (nutritionTotals.protein || 0) + (nutritionTotals.carbs || 0) + (nutritionTotals.fat || 0);
            if (anyTotal > 0) {
              nutritionSource = "spoonacular";
            }
          }
        } catch (err) {
          console.warn("Spoonacular nutrition compute failed:", err);
        }

        // fallback: OpenAI estimates if Spoonacular didn't produce totals
        if (!nutritionSource) {
          const estCalories = Number(r.estimatedCalories || r.calories || 0);
          const estProtein = (r.macros && Number(r.macros.protein)) || 0;
          const estCarbs = (r.macros && Number(r.macros.carbs)) || 0;
          const estFat = (r.macros && Number(r.macros.fat)) || 0;

          nutritionTotals = {
            calories: estCalories,
            protein: estProtein,
            carbs: estCarbs,
            fat: estFat
          };
          nutritionSource = "openai_estimate";
        }

        const perServing = {
          calories: Math.round((nutritionTotals.calories || 0) / Math.max(1, servings)),
          protein: Math.round((nutritionTotals.protein || 0) / Math.max(1, servings)),
          carbs: Math.round((nutritionTotals.carbs || 0) / Math.max(1, servings)),
          fat: Math.round((nutritionTotals.fat || 0) / Math.max(1, servings))
        };

        r.nutrition = {
          totals: {
            calories: Math.round(nutritionTotals.calories || 0),
            protein: Math.round(nutritionTotals.protein || 0),
            carbs: Math.round(nutritionTotals.carbs || 0),
            fat: Math.round(nutritionTotals.fat || 0)
          },
          perServing,
          source: nutritionSource
        };

        r.source = r.source || (nutritionSource === "spoonacular" ? "openai+spoonacular" : "openai");
        recipesWithNutrition.push(r);
      } // end for each recipe

      return res.json({ recipes: recipesWithNutrition });
    } // end if SPOONACULAR_KEY

    // No Spoonacular: return OpenAI recipes (estimates)
    parsed.recipes.forEach(r => {
      r.source = r.source || "openai";
      r.nutrition = r.nutrition || {
        totals: {
          calories: Math.round(r.estimatedCalories || 0),
          protein: Math.round(r.macros?.protein || 0),
          carbs: Math.round(r.macros?.carbs || 0),
          fat: Math.round(r.macros?.fat || 0)
        },
        perServing: {
          calories: Math.round((r.estimatedCalories || 0) / Math.max(1, servings)),
          protein: Math.round((r.macros?.protein || 0) / Math.max(1, servings)),
          carbs: Math.round((r.macros?.carbs || 0) / Math.max(1, servings)),
          fat: Math.round((r.macros?.fat || 0) / Math.max(1, servings))
        },
        source: "openai_estimate"
      };
    });

    return res.json({ recipes: parsed.recipes });
  } catch (err) {
    console.error("generate-meals error", err);
    return res.status(500).json({ error: "Internal server error", details: String(err) });
  }
}
