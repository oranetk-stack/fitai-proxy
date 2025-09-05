// api/generate-meals.js
// Defensive production-ready meal generator (OpenAI -> Spoonacular)
// - Upstash persistent caching (optional, disabled if env missing)
// - concurrency control for Spoonacular ingredient info
// - recipe-level cache + per-ingredient cache
// - rate limiting per-proxy-key (optional, uses Upstash if configured)
// - robust error handling and helpful debug output (no secrets printed)
//
// Required env vars:
// - OPENAI_API_KEY
// - PROXY_SECRET  (used by requireProxyKey in ../lib/utils.js)
// Optional:
// - SPOONACULAR_KEY
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// - CACHE_TTL_SECONDS, RECIPE_CACHE_TTL, RATE_LIMIT_PER_DAY, SPOONACULAR_CONCURRENCY, SENTRY_DSN
//
// Notes: commit package.json + package-lock.json with dependencies:
// npm install @upstash/redis p-limit @sentry/node
//
// IMPORTANT: Do NOT enable MOCK in production unless you want canned responses.

import { MOCK_RECIPES } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";
import * as Sentry from "@sentry/node";
import crypto from "crypto";

let RedisClient = null;
let pLimitFunc = null;
try {
  // optional packages — if not installed, we'll detect and keep going with in-memory behavior
  // (Vercel will fail build if package.json missing; these guards just help with runtime safety)
  // p-limit might be default or named export depending on bundler
  // eslint-disable-next-line node/no-extraneous-import
  // @ts-ignore
  import("p-limit").then((mod) => {
    pLimitFunc = mod && (typeof mod.default === "function" ? mod.default : mod);
  }).catch(() => {
    pLimitFunc = null;
  });
} catch (e) {
  pLimitFunc = null;
}

try {
  // @ts-ignore
  import("@upstash/redis").then((mod) => {
    RedisClient = mod && (mod.Redis || mod.default?.Redis || mod.default) || null;
  }).catch(() => {
    RedisClient = null;
  });
} catch (e) {
  RedisClient = null;
}

// synchronous checks: if package was installed and bundler resolved, require now.
// Some bundlers transform imports; the dynamic import above should set these for us quickly.
// We will still guard usage later.

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY || "";
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 86400);
const RECIPE_CACHE_TTL = Number(process.env.RECIPE_CACHE_TTL || 21600);
const RATE_LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 50);
const CONCURRENCY = Number(process.env.SPOONACULAR_CONCURRENCY || 5);

let redis = null;
if (UPSTASH_URL && UPSTASH_TOKEN) {
  try {
    // use synchronous require if bundler already installed it
    // eslint-disable-next-line node/no-extraneous-require
    const upstashModule = await import("@upstash/redis").catch(() => null);
    const Redis = upstashModule ? (upstashModule.Redis || upstashModule.default?.Redis || upstashModule.default) : null;
    if (Redis) {
      redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
    }
  } catch (err) {
    console.warn("Upstash init failed, continuing with in-memory cache only:", String(err));
    redis = null;
  }
}

// Init Sentry only if DSN provided
if (process.env.SENTRY_DSN) {
  try {
    Sentry.init({ dsn: process.env.SENTRY_DSN });
  } catch (e) {
    console.warn("Sentry init failed:", String(e));
  }
}

// In-memory ephemeral cache (per instance)
const inMemoryCache = new Map();
function memGet(key) {
  const e = inMemoryCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    inMemoryCache.delete(key);
    return null;
  }
  return e.value;
}
function memSet(key, value, ttl = CACHE_TTL_SECONDS) {
  inMemoryCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

// Upstash helpers (if redis available)
async function upstashGet(key) {
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch (e) {
    console.warn("Upstash get error:", String(e));
    return null;
  }
}
async function upstashSet(key, value, ttl = CACHE_TTL_SECONDS) {
  if (!redis) return null;
  try {
    await redis.set(key, JSON.stringify(value));
    if (ttl) await redis.expire(key, Number(ttl));
    return true;
  } catch (e) {
    console.warn("Upstash set error:", String(e));
    return null;
  }
}

async function cacheGet(key) {
  const m = memGet(key);
  if (m) return m;
  if (redis) {
    const v = await upstashGet(key);
    if (v) {
      memSet(key, v);
      return v;
    }
  }
  return null;
}
async function cacheSet(key, value, ttl = CACHE_TTL_SECONDS) {
  memSet(key, value, ttl);
  if (redis) await upstashSet(key, value, ttl);
}

// robust JSON parser (handles object or array, and tries to find JSON substring)
function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    // try to find first { ... } or [ ... ] block in the text
    const braceMatch = text.match(/[\{\[][\s\S]*[\}\]]/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch (e2) { return null; }
    }
    return null;
  }
}

function nutrientKey(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes("calorie")) return "calories";
  if (n.includes("protein")) return "protein";
  if (n.includes("fat")) return "fat";
  if (n.includes("carb")) return "carbs";
  return null;
}

async function checkAndIncrementRateLimit(proxyKey) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const key = `rl:${proxyKey || "anon"}:${dateStr}`;
  if (redis) {
    try {
      const cnt = await redis.incr(key);
      if (cnt === 1) await redis.expire(key, 86400);
      return { ok: cnt <= RATE_LIMIT_PER_DAY, count: cnt };
    } catch (e) {
      console.warn("Rate-limit redis error:", String(e));
      return { ok: true, count: 0 };
    }
  } else {
    const cur = memGet(key) || 0;
    const next = cur + 1;
    memSet(key, next, 86400);
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

// p-limit factory: handle default vs named export shapes
function makeLimiter(concurrency) {
  if (!pLimitFunc) {
    // try require synchronously as fallback
    try {
      // eslint-disable-next-line node/no-extraneous-require
      const mod = require("p-limit");
      pLimitFunc = typeof mod === "function" ? mod : (mod && mod.default) ? mod.default : null;
    } catch (e) {
      pLimitFunc = null;
    }
  }
  if (!pLimitFunc) {
    // fallback naive limiter (no concurrency control)
    return (fn) => fn;
  }
  return pLimitFunc(concurrency);
}

const limit = makeLimiter(CONCURRENCY);

// --- Spoonacular helpers (only used if SPOONACULAR_KEY present) ---
async function parseIngredientsWithSpoonacular(ingrList) {
  if (!SPOONACULAR_KEY) return null;
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
      console.warn("Spoonacular parseIngredients failed:", res.status, txt);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("parseIngredients error:", String(err));
    return null;
  }
}

async function getIngredientInfo(id, amount, unit) {
  if (!SPOONACULAR_KEY) return null;
  const key = `inginfo:${id}:${amount}:${unit}`;
  try {
    const cached = await cacheGet(key);
    if (cached) return cached;
    const url = new URL(`https://api.spoonacular.com/food/ingredients/${id}/information`);
    url.searchParams.set("apiKey", SPOONACULAR_KEY);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("unit", String(unit));
    const res = await fetch(url.toString());
    if (!res.ok) {
      const txt = await res.text();
      const fail = { error: true, status: res.status, text: txt };
      await cacheSet(key, fail, 60);
      return fail;
    }
    const json = await res.json();
    await cacheSet(key, json, CACHE_TTL_SECONDS);
    return json;
  } catch (err) {
    const fail = { error: true, message: String(err) };
    await cacheSet(key, fail, 60);
    return fail;
  }
}

// --- Handler ---
export default async function handler(req, res) {
  // simple debug endpoint for quick checks: ?debug=true
  if (req.method === "GET" && req.query?.debug === "true") {
    return res.json({
      status: "ok",
      env: {
        OPENAI_key_present: !!OPENAI_KEY,
        SPOONACULAR_key_present: !!SPOONACULAR_KEY,
        UPSTASH_present: !!(UPSTASH_URL && UPSTASH_TOKEN)
      }
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // proxy key check (this function handles response if invalid)
    if (!requireProxyKey(req, res)) return;

    const { ingredients = [], diet = "none", calorieTarget = null, servings = 1, userProfile = {} } = req.body || {};
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "Please provide an ingredients array in the request body." });
    }

    // rate limit
    const proxyKey = (req.headers["x-proxy-key"] || req.headers["x-proxy-token"] || req.headers["authorization"]) || "anon";
    const rl = await checkAndIncrementRateLimit(proxyKey);
    if (!rl.ok) {
      return res.status(429).json({ error: "Rate limit exceeded", usedToday: rl.count, limit: RATE_LIMIT_PER_DAY });
    }

    // mock mode
    if ((process.env.MOCK || "false") === "true") {
      return res.json({ recipes: MOCK_RECIPES, notes: "mock mode", input: { ingredients, diet, calorieTarget, servings } });
    }

    // recipe-level cache
    const rKey = recipeCacheKey({ ingredients, diet, servings });
    try {
      const cachedR = await cacheGet(rKey);
      if (cachedR) return res.json({ recipes: cachedR, cached: true });
    } catch (e) {
      console.warn("recipe cache get error:", String(e));
    }

    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in server environment" });
    }

    // Build prompt
    const systemPrompt = `You are an expert chef and registered dietitian. Given pantry ingredients and user constraints, respond ONLY with valid JSON.
Top-level: { "recipes": [ ... ] }
Each recipe should include:
- title (string)
- description (string)
- ingredients (array of { name, quantity })
- steps (array of strings)
- estimatedCalories (number)
- macros { protein:number, carbs:number, fat:number }
Return up to 3 recipes. Do NOT include extra commentary or markdown.`;

    const userPrompt = `Ingredients: ${ingredients.join(", ")}
Diet: ${diet}
Calorie target: ${calorieTarget || "none"}
Servings: ${servings}
UserProfile: ${JSON.stringify(userProfile)}`;

    // Call OpenAI
    let openaiData;
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          temperature: 0.2,
          max_tokens: 1200
        })
      });
      openaiData = await resp.json();
    } catch (err) {
      console.error("OpenAI request failed:", String(err));
      if (typeof Sentry.captureException === "function") Sentry.captureException(err);
      return res.status(502).json({ error: "Failed to call OpenAI", details: String(err) });
    }

    const text = openaiData?.choices?.[0]?.message?.content || openaiData?.choices?.[0]?.text || null;
    const parsed = safeParseJson(text);
    if (!parsed || !Array.isArray(parsed.recipes)) {
      console.warn("OpenAI returned unexpected format:", text?.slice?.(0, 100) ?? String(openaiData));
      if (typeof Sentry.captureMessage === "function") Sentry.captureMessage("OpenAI returned unexpected format");
      return res.status(502).json({ error: "OpenAI returned unexpected format", raw: text, debug: openaiData });
    }

    // If spoonacular configured, enrich nutrition using spoonacular with caching + concurrency
    if (SPOONACULAR_KEY) {
      const results = [];
      for (const r of parsed.recipes) {
        let nutritionTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        let nutritionSource = null;

        try {
          const ingrList = (r.ingredients || []).map(i => `${i.quantity || ""} ${i.name || ""}`.trim()).filter(Boolean).join("\n");
          const parsedIngs = await parseIngredientsWithSpoonacular(ingrList);
          if (Array.isArray(parsedIngs) && parsedIngs.length > 0) {
            const tasks = parsedIngs.map(p =>
              limit(async () => {
                if (!p?.id || !p?.amount) return null;
                const unit = p.unit || p.unitShort || p.unitString || "unit";
                return await getIngredientInfo(p.id, p.amount, unit);
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
          console.warn("Error computing spoonacular nutrition:", String(err));
          if (typeof Sentry.captureException === "function") Sentry.captureException(err);
        }

        if (!nutritionSource) {
          const estCalories = Number(r.estimatedCalories || r.calories || 0);
          const estProtein = Number(r.macros?.protein || 0);
          const estCarbs = Number(r.macros?.carbs || 0);
          const estFat = Number(r.macros?.fat || 0);
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
        results.push(r);
      }
      try { await cacheSet(rKey, results, RECIPE_CACHE_TTL); } catch (e) { console.warn("recipe cache set failed:", String(e)); }
      return res.json({ recipes: results, cached: false });
    }

    // No Spoonacular configured: attach OpenAI estimates
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

    try { await cacheSet(rKey, parsed.recipes, RECIPE_CACHE_TTL); } catch (e) { console.warn("recipe cache set failed:", String(e)); }
    return res.json({ recipes: parsed.recipes, cached: false });
  } catch (err) {
    console.error("Unhandled generate-meals error:", String(err));
    if (typeof Sentry.captureException === "function") Sentry.captureException(err);
    return res.status(500).json({ error: "Internal server error", details: String(err) });
  }
}
