# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WealthOS is a vanilla JavaScript SPA (no build system) for AI-powered personal wealth tracking. It runs as static files served via Vercel, with a minimal serverless backend for API proxying.

## Development

**No build step required.** Open `index.html` directly in a browser or use a local static server:

```bash
npx serve .          # or: python3 -m http.server 8080
```

**No tests exist** in this project.

**Deploy:** Push to `main` on GitHub — Vercel auto-deploys. Environment variables are configured in the Vercel dashboard.

## Architecture

### Frontend (client-side only)

- **`index.html`** — entire app shell: all markup, modals, dashboard views, and CDN script tags
- **`script.js`** — all application logic (~5000 lines), no modules/bundler

All state lives in global variables in `script.js`:
- `assets[]` — currently loaded assets for the active portfolio
- `milestones[]` — wealth goals
- `settings{}` — user preferences
- `currentUser` — logged-in user object (from `localStorage`)
- `activePortfolioId` — selected portfolio
- `priceCache{}` — cached stock price lookups

**Rendering pattern:** Functions prefixed with `r` (e.g., `rSnapshot()`, `rInsights()`, `rCat()`) rebuild DOM innerHTML for their respective dashboard sections. Call these after any state mutation.

**Data flow:**
1. Assets are stored in `localStorage` (`pw_assets_{userId}`)
2. On login, assets are loaded from localStorage and optionally synced with Supabase
3. Price updates hit `/api/prices`, results are cached in `priceCache` and localStorage
4. `calcPortfolio()` recomputes totals from the global `assets[]` array

### Serverless API (`/api/`)

| File | Purpose | Key env vars |
|------|---------|-------------|
| `api/chat.js` | Proxies to Anthropic Claude API | `ANTHROPIC_API_KEY` |
| `api/prices.js` | Fetches stock prices from Yahoo Finance | — |
| `api/paddle-webhook.js` | Handles Paddle subscription webhooks | `PADDLE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_KEY` |

### External Services

- **Supabase** — auth + cloud sync. Public anon key is intentionally hardcoded in `script.js`. Service key is only used server-side in the webhook handler.
- **Paddle** — subscriptions. Live token is intentionally public in `index.html`.
- **Anthropic Claude** — AI chat, proxied through `/api/chat` to keep API key server-side.

### Storage Strategy

Client-side localStorage keys (all prefixed `pw_`):
- `pw_session` — current user
- `pw_assets_{userId}` — user's assets
- `pw_history_{userId}` — net worth snapshots (up to 365 days)
- `pw_settings_{userId}` — preferences

Server-side Supabase tables: `users` (id, email, plan) and `portfolio_snapshots` (user_id, total_value, snapshot_date).

### Plan Tiers

```
Free:    50 assets max, 20 AI messages/day
Pro:     Unlimited assets, unlimited AI chat, advanced analytics
Private: Everything in Pro
```

Plan is stored in `currentUser.plan` and checked before gating features.
