import { MOCK_RECIPES } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;
  const MOCK = (process.env.MOCK || "true") === "true";
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
    return res.status(500).json({ error: "OPENAI_API_KEY not set in environment. Cannot generate recipes." });
  }
  const systemPrompt = `You are an expert chef and registered dietitian. You will be given a list of pantry ingredients and user constraints.
Return EXACTLY JSON: an array named "recipes" with up to 3 recipe objects.
Each recipe object must have: title, description, ingredients (array of {name,quantity}), steps (array of strings), estimatedCalories (per serving), macros {protein,carbs,fat} (grams).
Do not output any extra commentary or markdown.`;
  const userPrompt = `Ingredients: ${ingredients.join(", ")}.
Diet: ${diet}.
Calorie target (optional): ${calorieTarget || "none"}.
Servings: ${servings}.
User profile: ${JSON.stringify(userProfile)}`;
  try {
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.25,
        max_tokens: 900
      })
    });
    const openaiData = await openaiResp.json();
    const text = openaiData?.choices?.[0]?.message?.content;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text && text.match(/\{[\s\S]*\}$/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    }
    if (!parsed || !parsed.recipes) {
      return res.status(500).json({ error: "OpenAI returned unexpected format", raw: text, debug: openaiData });
    }
    if (SPOONACULAR_KEY) {
      const recipesWithNutrition = [];
      for (let r of parsed.recipes) {
        try {
          const ingrList = r.ingredients.map((i) => `${i.quantity} ${i.name}`).join("\n");
          const spoonRes = await fetch(
            `https://api.spoonacular.com/recipes/parseIngredients?apiKey=${SPOONACULAR_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ingredientList: ingrList })
            }
          );
          const spoonJson = await spoonRes.json();
          r.source = r.source || "openai+spoonacular";
        } catch (err) {
          r.source = r.source || "openai";
        }
        recipesWithNutrition.push(r);
      }
      return res.json({ recipes: recipesWithNutrition });
    }
    return res.json({ recipes: parsed.recipes });
  } catch (err) {
    console.error("generate-meals error:", err);
    return res.status(500).json({ error: "Internal server error generating meals", details: String(err) });
  }
}
