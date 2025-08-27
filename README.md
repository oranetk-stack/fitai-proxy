# FitAI Proxy (Vercel serverless)

This repository provides four serverless endpoints for the FitAI app:
- `POST /api/parse-image` — parse pantry photo (mock by default)
- `POST /api/generate-meals` — generate recipe suggestions (mock by default)
- `POST /api/chat` — nutrition assistant chat (mock by default)
- `POST /api/barcode-lookup` — UPC/barcode lookup (mock by default)

**Important:** This project runs in **mock mode** by default (safe for testing). To enable real API calls, set `MOCK=false` and add real API keys in environment variables.
