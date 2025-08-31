// api/generate-meals.js
import { MOCK_RECIPES } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;

// Helper: safe JSON parse attempt
function safeParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {
    const jsonMatch = text && text.match(/\{[\s\S]*\}$/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch (e2) { return null; }
    }
    return null;
  }
}

// Normalize nutrient name to key we care about
function nutrientKey(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("calorie")) return "calories";
  if (n.includes("protein")) return "protein";
  if (n.includes("fat")) return "fat";
  if (n.includes("carb")) return "carbs";
  return null;
}

// MOCK feature flag: set MOCK="true" in Vercel to enable canned responses.
// Default: real mode (when MOCK is not "true").
const MOCK = process.env.MOCK === "true";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;

  const { ingredients = [], diet = "none", calorieTarget = null, servings = 1, userProfile = {} } = req.body || {};
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: "Please provide an ingredients array in the request body." });
  }

  // MOCK short-circuit
  if (MOCK) {
    return res.json({
      recipes: MOCK_RECIPES,
      notes: "mock mode",
      input: { ingredients, diet, calorieTarget, servings }
    });
  }

  // Ensure OpenAI key exists
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
    // 1) Ask OpenAI for structured recipes
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

    // 2) If Spoonacular available, attempt to parse ingredients (we may have done this earlier),
    //    then compute nutrition per ingredient by calling the ingredient information endpoint.
    if (SPOONACULAR_KEY) {
      const recipesWithNutrition = [];

      for (const r of parsed.recipes) {
        // default values
        let nutritionTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        let nutritionSource = null;

        try {
          // Build a simple ingredient list for parseIngredients call (quantity + name lines)
          const ingrList = (r.ingredients || [])
            .map(i => `${i.quantity || ""} ${i.name || ""}`.trim())
            .filter(Boolean)
            .join("\n");

          // 2a) Parse ingredients (we may already have parsed earlier)
          const form = new URLSearchParams();
          form.append("ingredientList", ingrList);

          const spoonParseRes = await fetch(
            `https://api.spoonacular.com/recipes/parseIngredients?apiKey=${SPOONACULAR_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: form.toString()
            }
          );

          let spoonParsed = null;
          if (spoonParseRes.ok) {
            spoonParsed = await spoonParseRes.json(); // array of parsed ingredient objects with id/amount/unit
          } else {
            const txt = await spoonParseRes.text();
            console.warn("Spoonacular parseIngredients failed:", spoonParseRes.status, txt);
            spoonParsed = null;
          }

          // 2b) For each parsed ingredient, call ingredient information to get nutrition for that amount
          if (Array.isArray(spoonParsed) && spoonParsed.length > 0) {
            // Accumulate nutrition across ingredients
            for (const p of spoonParsed) {
              try {
                // p should have id, amount, unit. If not present, skip.
                const id = p.id;
                const amount = p.amount;
                let unit = p.unit || p.unitShort || p.unitString || "";

                if (!id || !amount || !unit) {
                  // fallback: skip this ingredient for spoonacular nutrition
                  continue;
                }

                // Build ingredient info URL: /food/ingredients/{id}/information?amount={amount}&unit={unit}
                const infoUrl = new URL(`https://api.spoonacular.com/food/ingredients/${id}/information`);
                infoUrl.searchParams.set("apiKey", SPOONACULAR_KEY);
                infoUrl.searchParams.set("amount", String(amount));
                infoUrl.searchParams.set("unit", String(unit));

                const infoRes = await fetch(infoUrl.toString(), { method: "GET" });
                if (!infoRes.ok) {
                  const txt = await infoRes.text();
                  console.warn("Ingredient information fetch failed:", infoRes.status, txt);
                  continue;
                }
                const infoJson = await infoRes.json();
                const nutrients = infoJson?.nutrition?.nutrients || [];

                // Extract targeted nutrients (names vary; match by lowercase contains)
                for (const nutrient of nutrients) {
                  const key = nutrientKey(nutrient?.name || nutrient?.title || "");
                  if (!key) continue;
                  // nutrient.amount is typically in grams for macros and kcal for calories
                  const value = Number(nutrient.amount) || 0;
                  nutritionTotals[key] = (nutritionTotals[key] || 0) + value;
                }
              } catch (perIngErr) {
                console.warn("Error computing ingredient nutrition:", perIngErr);
                // continue to next ingredient
              }
            } // end each parsed ingredient

            // If we have any totals > 0, consider spoonacular successful
            const anyTotal = (nutritionTotals.calories || 0) + (nutritionTotals.protein || 0) + (nutritionTotals.carbs || 0) + (nutritionTotals.fat || 0);
            if (anyTotal > 0) {
              nutritionSource = "spoonacular";
              // attach spoonParsed raw info for debugging/inspection
              r.spoonacular = spoonParsed;
            }
          } // end spoonParsed usable
        } catch (err) {
          console.warn("Spoonacular nutrition compute failed for recipe:", err);
        }

        // 3) If spoonacular failed to compute nutrition, fall back to OpenAI's estimates in the recipe
        if (!nutritionSource) {
          // Use the OpenAI-supplied estimatedCalories and macros if present
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

        // 4) Normalize and attach totals and per-serving
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

        // ensure source flag exists
        r.source = r.source || (nutritionSource === "spoonacular" ? "openai+spoonacular" : "openai");

        recipesWithNutrition.push(r);
      } // end for each recipe

      return res.json({ recipes: recipesWithNutrition });
    } // end SPOONACULAR_KEY branch

    // No Spoonacular configured: return OpenAI recipes and mark source
    parsed.recipes.forEach(r => {
      r.source = r.source || "openai";
      // ensure nutrition field exists as best-effort
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
