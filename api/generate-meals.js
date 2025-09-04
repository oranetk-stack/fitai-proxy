// api/generate-meals.js
// Production-ready: OpenAI -> Spoonacular pipeline with Upstash caching, concurrency control,
// rate-limiting, and graceful fallbacks.
//
// Required env vars:
// OPENAI_API_KEY, SPOONACULAR_KEY, PROXY_SECRET
// Optional for persistent cache & rate-limits:
// UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// CACHE_TTL_SECONDS (default 86400), RECIPE_CACHE_TTL (default 21600),
// RATE_LIMIT_PER_DAY (default 50), SPOONACULAR_CONCURRENCY (default 5), SENTRY_DSN

import { MOCK_RECIPES } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";
import { Redis } from "@upstash/redis";
import pLimit from "p-limit";
import * as Sentry from "@sentry/node";
import crypto from "crypto";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 86400); // 24h
const RECIPE_CACHE_TTL = Number(process.env.RECIPE_CACHE_TTL || 21600); // 6h
const RATE_LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 50);
const CONCURRENCY = Number(process.env.SPOONACULAR_CONCURRENCY || 5);

// init optional services
let redis = null;
if (UPSTASH_URL && UPSTASH_TOKEN) {
  redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
}

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

// in-memory fallback cache (ephemeral)
const inMemoryCache = new Map();
function memGet(key) {
  const item = inMemoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    inMemoryCache.delete(key);
    return null;
  }
  return item.value;
}
function memSet(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  inMemoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// Upstash helpers
async function upstashGet(key) {
  if (!redis) return null;
  try {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    console.warn("Upstash get error", e);
    return null;
  }
}
async function upstashSet(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  if (!redis) return null;
  try {
    await redis.set(key, JSON.stringify(value));
    if (ttlSeconds) await redis.expire(key, Number(ttlSeconds));
    return true;
  } catch (e) {
    console.warn("Upstash set error", e);
    return null;
  }
}

async function cacheGet(key) {
  const mem = memGet(key);
  if (mem) return mem;
  if (redis) {
    const v = await upstashGet(key);
    if (v) {
      memSet(key, v);
      return v;
    }
    return null;
  }
  return null;
}
async function cacheSet(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  memSet(key, value, ttlSeconds);
  if (redis) await upstashSet(key, value, ttlSeconds);
}

function safeParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (er) { return null; }
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

async function checkAndIncrementRateLimit(proxyKey) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const rlKey = `rl:${proxyKey || "anon"}:${dateStr}`;
  if (redis) {
    try {
      const count = await redis.incr(rlKey);
      if (count === 1) {
        await redis.expire(rlKey, 86400);
      }
      return { ok: count <= RATE_LIMIT_PER_DAY, count };
    } catch (e) {
      console.warn("rate limit redis error", e);
      return { ok: true, count: 0 };
    }
  } else {
    const memKey = `${rlKey}`;
    const cur = memGet(memKey) || 0;
    const next = cur + 1;
    memSet(memKey, next, 86400);
    return { ok: next <= RATE_LIMIT_PER_DAY, count: next };
  }
}

function recipeCacheKey({ ingredients, diet, servings }) {
  const normalized = {
    ingredients: [...ingredients].map(s => String(s).trim().toLowerCase()).sort(),
    diet: String(diet || "").toLowerCase(),
    servings: Number(servings || 1)
  };
  const payload = JSON.stringify(normalized);
  return "recipe:" + crypto.createHash("sha256").update(payload).digest("hex");
}

const limit = pLimit(CONCURRENCY);

async function getIngredientInfo(id, amount, unit) {
  const key = `inginfo:${id}:${amount}:${unit}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  try {
    const infoUrl = new URL(`https://api.spoonacular.com/food/ingredients/${id}/information`);
    infoUrl.searchParams.set("apiKey", SPOONACULAR_KEY);
    infoUrl.searchParams.set("amount", String(amount));
    infoUrl.searchParams.set("unit", String(unit));
    const infoRes = await fetch(infoUrl.toString());
    if (!infoRes.ok) {
      const txt = await infoRes.text();
      const fail = { error: true, status: infoRes.status, text: txt };
      await cacheSet(key, fail, 60);
      return fail;
    }
    const infoJson = await infoRes.json();
    await cacheSet(key, infoJson, CACHE_TTL_SECONDS);
    return infoJson;
  } catch (e) {
    const fail = { error: true, message: String(e) };
    await cacheSet(key, fail, 60);
    return fail;
  }
}

async function parseIngredientsWithSpoonacular(ingrList) {
  try {
    const form = new URLSearchParams();
    form.append("ingredientList", ingrList);
    const url = `https://api.spoonacular.com/recipes/parseIngredients?apiKey=${SPOONACULAR_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn("parseIngredients failed", res.status, txt);
      return null;
    }
    const json = await res.json();
    return json;
  } catch (e) {
    console.warn("parseIngredients error", e);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireProxyKey(req, res)) return;

  const { ingredients = [], diet = "none", calorieTarget = null, servings = 1, userProfile = {} } = req.body || {};
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: "Please provide an ingredients array in the request body." });
  }

  const proxyKeyHeader = req.headers["x-proxy-key"] || req.headers["x-proxy-key".toLowerCase()];
  const rl = await checkAndIncrementRateLimit(proxyKeyHeader);
  if (!rl.ok) {
    return res.status(429).json({ error: "Rate limit exceeded", usedToday: rl.count, limit: RATE_LIMIT_PER_DAY });
  }

  if (process.env.MOCK === "true") {
    return res.json({ recipes: MOCK_RECIPES, notes: "mock mode", input: { ingredients, diet, calorieTarget, servings } });
  }

  const rKey = recipeCacheKey({ ingredients, diet, servings });
  try {
    const cachedRecipe = await cacheGet(rKey);
    if (cachedRecipe) {
      return res.json({ recipes: cachedRecipe, cached: true });
    }
  } catch (e) {
    console.warn("recipe cache get error", e);
  }

  if (!OPENAI_KEY) {
    console.error("OPENAI_API_KEY missing");
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
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        temperature: 0.2,
        max_tokens: 1200
      })
    });
    const openaiData = await openaiResp.json();
    const text = openaiData?.choices?.[0]?.message?.content;
    const parsed = safeParseJson(text);

    if (!parsed || !Array.isArray(parsed.recipes)) {
      Sentry.captureMessage && Sentry.captureMessage("OpenAI returned unexpected format");
      console.error("OpenAI returned non-JSON or unexpected format", { openaiData });
      return res.status(502).json({ error: "AI returned unexpected format", details: openaiData?.error || "parsing failed" });
    }

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

          const parsedIngs = await parseIngredientsWithSpoonacular(ingrList);
          if (Array.isArray(parsedIngs) && parsedIngs.length > 0) {
            const tasks = parsedIngs.map(p =>
              limit(async () => {
                if (!p.id || !p.amount) return null;
                const unit = p.unit || p.unitShort || p.unitString || "unit";
                const info = await getIngredientInfo(p.id, p.amount, unit);
                return info;
              })
            );

            const infos = await Promise.all(tasks);

            for (const info of infos) {
              if (!info || info.error) continue;
              const nutrients = info?.nutrition?.nutrients || [];
              for (const nutrient of nutrients) {
                const key = nutrientKey(nutrient?.name || nutrient?.title || "");
                if (!key) continue;
                const value = Number(nutrient.amount) || 0;
                nutritionTotals[key] = (nutritionTotals[key] || 0) + value;
              }
            }

            const anyTotal = (nutritionTotals.calories || 0) + (nutritionTotals.protein || 0) + (nutritionTotals.carbs || 0) + (nutritionTotals.fat || 0);
            if (anyTotal > 0) nutritionSource = "spoonacular";

            r.spoonacular = parsedIngs;
          }
        } catch (err) {
          console.warn("Error computing spoonacular nutrition:", err);
          Sentry.captureException && Sentry.captureException(err);
        }

        if (!nutritionSource) {
          const estCalories = Number(r.estimatedCalories || r.calories || 0);
          const estProtein = (r.macros && Number(r.macros.protein)) || 0;
          const estCarbs = (r.macros && Number(r.macros.carbs)) || 0;
          const estFat = (r.macros && Number(r.macros.fat)) || 0;
          nutritionTotals = { calories: estCalories, protein: estProtein, carbs: estCarbs, fat: estFat };
          nutritionSource = "openai_estimate";
        }

        const totals = {
          calories: Math.round(nutritionTotals.calories || 0),
          protein: Math.round(nutritionTotals.protein || 0),
          carbs: Math.round(nutritionTotals.carbs || 0),
          fat: Math.round(nutritionTotals.fat || 0)
        };
        const perServing = {
          calories: Math.round(totals.calories / Math.max(1, servings)),
          protein: Math.round(totals.protein / Math.max(1, servings)),
          carbs: Math.round(totals.carbs / Math.max(1, servings)),
          fat: Math.round(totals.fat / Math.max(1, servings))
        };

        r.nutrition = { totals, perServing, source: nutritionSource };
        r.source = r.source || (nutritionSource === "spoonacular" ? "openai+spoonacular" : "openai");
        recipesWithNutrition.push(r);
      }

      try { await cacheSet(rKey, recipesWithNutrition, RECIPE_CACHE_TTL); } catch (e) { console.warn("recipe cache set failed", e); }

      return res.json({ recipes: recipesWithNutrition, cached: false });
    }

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

    try { await cacheSet(rKey, parsed.recipes, RECIPE_CACHE_TTL); } catch (e) { console.warn("recipe cache set failed", e); }

    return res.json({ recipes: parsed.recipes, cached: false });
  } catch (err) {
    console.error("generate-meals error", err);
    Sentry.captureException && Sentry.captureException(err);
    return res.status(500).json({ error: "Internal server error", details: String(err) });
  }
}
