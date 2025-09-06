
// api/generate-meals.js
// Safe production handler — dynamic optional imports happen inside the handler to avoid startup crashes.
// Required env: OPENAI_API_KEY, PROXY_SECRET
// Optional: SPOONACULAR_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, SENTRY_DSN
// Optional tuning envs: CACHE_TTL_SECONDS, RECIPE_CACHE_TTL, RATE_LIMIT_PER_DAY, SPOONACULAR_CONCURRENCY, MOCK

import { MOCK_RECIPES } from "../lib/mockData.js";
import { requireProxyKey } from "../lib/utils.js";
import crypto from "crypto";

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY || "";
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 86400);
const RECIPE_CACHE_TTL = Number(process.env.RECIPE_CACHE_TTL || 21600);
const RATE_LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 50);
const CONCURRENCY = Number(process.env.SPOONACULAR_CONCURRENCY || 5);

// simple in-memory cache (ephemeral)
const inMemoryCache = new Map();
function memGet(key) {
  const v = inMemoryCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    inMemoryCache.delete(key);
    return null;
  }
  return v.value;
}
function memSet(key, value, ttl = CACHE_TTL_SECONDS) {
  inMemoryCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

function safeParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {
    const m = text.match(/[\{\[][\s\S]*[\}\]]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) { return null; }
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

function recipeCacheKey({ ingredients, diet, servings }) {
  const normalized = {
    ingredients: [...ingredients].map(s => String(s).trim().toLowerCase()).sort(),
    diet: String(diet || "").toLowerCase(),
    servings: Number(servings || 1)
  };
  const payload = JSON.stringify(normalized);
  return "recipe:" + crypto.createHash("sha256").update(payload).digest("hex");
}

export default async function handler(req, res) {
  // small debug check (no heavy imports)
  if (req.method === "GET" && req.query?.debug === "true") {
    return res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      env: {
        OPENAI_key_present: !!OPENAI_KEY,
        SPOONACULAR_key_present: !!SPOONACULAR_KEY,
        UPSTASH_present: !!(UPSTASH_URL && UPSTASH_TOKEN),
        MOCK: process.env.MOCK || null
      }
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // require proxy key (util returns response if missing)
  if (!requireProxyKey(req, res)) return;

  // Optional runtime objects (loaded lazily)
  let redis = null;
  let limit = null;
  let Sentry = null;

  // initialize optional libs only when needed to avoid startup crashes
  async function ensureOptionalLibs() {
    // p-limit
    if (!limit) {
      try {
        const pLimitMod = await import("p-limit");
        const pLimitFunc = pLimitMod && (typeof pLimitMod.default === "function" ? pLimitMod.default : pLimitMod);
        limit = pLimitFunc ? pLimitFunc(CONCURRENCY) : (fn => fn());
      } catch {
        limit = (fn) => fn(); // fallback no concurrency
      }
    }
    // Upstash Redis
    if (!redis && UPSTASH_URL && UPSTASH_TOKEN) {
      try {
        const upstash = await import("@upstash/redis");
        const Redis = upstash && (upstash.Redis || upstash.default?.Redis || upstash.default);
        if (Redis) {
          redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
        }
      } catch (e) {
        // leave redis null (in-memory fallback will be used)
        console.warn("Upstash init failed:", String(e));
        redis = null;
      }
    }
    // Sentry (optional)
    if (!Sentry && process.env.SENTRY_DSN) {
      try {
        const SentryMod = await import("@sentry/node");
        Sentry = SentryMod && (SentryMod.default || SentryMod);
        if (Sentry && Sentry.init) Sentry.init({ dsn: process.env.SENTRY_DSN });
      } catch (e) {
        console.warn("Sentry init failed:", String(e));
        Sentry = null;
      }
    }
  }

  // cache helpers (use upstash if present, otherwise in-memory)
  async function upstashGet(key) {
    if (!redis) return null;
    try {
      const v = await redis.get(key);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      console.warn("upstash get error", String(e));
      return null;
    }
  }
  async function upstashSet(key, value, ttl = CACHE_TTL_SECONDS) {
    if (!redis) return null;
    try {
      await redis.set(key, JSON.stringify(value));
      if (ttl) await redis.expire(key, ttl);
      return true;
    } catch (e) {
      console.warn("upstash set error", String(e));
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

  // rate limiter (Upstash-backed or in-memory)
  async function checkAndIncrementRateLimit(proxyKey) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const rlKey = `rl:${proxyKey || "anon"}:${dateStr}`;
    if (redis) {
      try {
        const count = await redis.incr(rlKey);
        if (count === 1) await redis.expire(rlKey, 86400);
        return { ok: count <= RATE_LIMIT_PER_DAY, count };
      } catch (e) {
        console.warn("rate limit redis error", String(e));
        return { ok: true, count: 0 };
      }
    } else {
      const cur = memGet(rlKey) || 0;
      const next = cur + 1;
      memSet(rlKey, next, 86400);
      return { ok: next <= RATE_LIMIT_PER_DAY, count: next };
    }
  }

  // begin processing
  try {
    await ensureOptionalLibs();

    const { ingredients = [], diet = "none", calorieTarget = null, servings = 1, userProfile = {} } = req.body || {};
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "Please provide an ingredients array in the request body." });
    }

    const proxyKeyHeader = req.headers["x-proxy-key"] || req.headers["x-proxy-token"] || req.headers["authorization"] || "anon";
    const rl = await checkAndIncrementRateLimit(proxyKeyHeader);
    if (!rl.ok) return res.status(429).json({ error: "Rate limit exceeded", usedToday: rl.count, limit: RATE_LIMIT_PER_DAY });

    // mock mode
    if ((process.env.MOCK || "false") === "true") {
      return res.json({ recipes: MOCK_RECIPES, notes: "mock mode", input: { ingredients, diet, calorieTarget, servings } });
    }

    // recipe cache lookup
    const rKey = recipeCacheKey({ ingredients, diet, servings });
    try {
      const cached = await cacheGet(rKey);
      if (cached) return res.json({ recipes: cached, cached: true });
    } catch (e) {
      console.warn("recipe cache get failed:", String(e));
    }

    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in environment" });
    }

    // Build OpenAI prompt
    const systemPrompt = `You are an expert chef and registered dietitian. Given pantry ingredients and user constraints, respond ONLY with valid JSON.
Top-level: { "recipes": [ ... ] }
Each recipe must include: title, description, ingredients (array of {name,quantity}), steps (array of strings), estimatedCalories (number), macros {protein,carbs,fat}.
Return up to 3 recipes. No extra commentary.`;
    const userPrompt = `Ingredients: ${ingredients.join(", ")}\nDiet: ${diet}\nCalorie target: ${calorieTarget || "none"}\nServings: ${servings}\nUserProfile: ${JSON.stringify(userProfile)}`;

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
      console.error("OpenAI call failed:", String(err));
      if (Sentry && typeof Sentry.captureException === "function") Sentry.captureException(err);
      return res.status(502).json({ error: "OpenAI request failed", details: String(err) });
    }

    const text = openaiData?.choices?.[0]?.message?.content || openaiData?.choices?.[0]?.text || null;
    const parsed = safeParseJson(text);
    if (!parsed || !Array.isArray(parsed.recipes)) {
      console.warn("OpenAI returned unexpected format", String(text)?.slice?.(0, 200));
      if (Sentry && typeof Sentry.captureMessage === "function") Sentry.captureMessage("OpenAI returned unexpected format");
      return res.status(502).json({ error: "OpenAI returned unexpected format", raw: text, debug: openaiData });
    }

    // If Spoonacular key present, enrich nutrition
    if (SPOONACULAR_KEY) {
      // helper to parse ingredients via Spoonacular
      async function parseIngredientsWithSpoonacular(ingrList) {
        try {
          const form = new URLSearchParams();
          form.append("ingredientList", ingrList);
          const url = `https://api.spoonacular.com/recipes/parseIngredients?apiKey=${SPOONACULAR_KEY}`;
          const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
          if (!r.ok) {
            const txt = await r.text();
            console.warn("spoonacular parse failed", r.status, txt);
            return null;
          }
          return await r.json();
        } catch (e) {
          console.warn("parseIngredients error", String(e));
          return null;
        }
      }

      async function getIngredientInfo(id, amount, unit) {
        const key = `inginfo:${id}:${amount}:${unit}`;
        try {
          const cached = await cacheGet(key);
          if (cached) return cached;
          const url = new URL(`https://api.spoonacular.com/food/ingredients/${id}/information`);
          url.searchParams.set("apiKey", SPOONACULAR_KEY);
          url.searchParams.set("amount", String(amount));
          url.searchParams.set("unit", String(unit || "unit"));
          const r = await fetch(url.toString());
          if (!r.ok) {
            const txt = await r.text();
            const fail = { error: true, status: r.status, text: txt };
            await cacheSet(key, fail, 60);
            return fail;
          }
          const json = await r.json();
          await cacheSet(key, json, CACHE_TTL_SECONDS);
          return json;
        } catch (e) {
          const fail = { error: true, message: String(e) };
          await cacheSet(key, fail, 60);
          return fail;
        }
      }

      const recipesWithNutrition = [];
      for (const r of parsed.recipes) {
        let nutritionTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        let nutritionSource = null;
        try {
          const ingrList = (r.ingredients || []).map(i => `${i.quantity || ""} ${i.name || ""}`.trim()).filter(Boolean).join("\n");
          const parsedIngs = await parseIngredientsWithSpoonacular(ingrList);
          if (Array.isArray(parsedIngs) && parsedIngs.length > 0) {
            const tasks = parsedIngs.map(p => limit(async () => {
              if (!p?.id || !p?.amount) return null;
              const unit = p.unit || p.unitShort || p.unitString || "unit";
              return await getIngredientInfo(p.id, p.amount, unit);
            }));
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
        } catch (e) {
          console.warn("Error computing spoonacular nutrition:", String(e));
          if (Sentry && typeof Sentry.captureException === "function") Sentry.captureException(e);
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
        recipesWithNutrition.push(r);
      }

      try { await cacheSet(rKey, recipesWithNutrition, RECIPE_CACHE_TTL); } catch (e) { console.warn("recipe cache set failed:", String(e)); }
      return res.json({ recipes: recipesWithNutrition, cached: false });
    }

    // No Spoonacular — return OpenAI parsed recipes
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
    // safe Sentry capture
    try { if (Sentry && typeof Sentry.captureException === "function") Sentry.captureException(err); } catch {}
    return res.status(500).json({ error: "Internal server error", details: String(err) });
  }
}
