# Omnya Portal

Creator, client and staff portal for a UGC agency: campaigns, content submissions, social analytics, creator earnings and payouts.

React SPA (Create React App) + Vercel serverless functions in `api/` + Supabase (Postgres, Auth, Storage).

## Getting started

```bash
npm install
cp .env.example .env          # fill in values; see comments in the file
npm start                     # SPA on :3000 (does not serve /api/*)
node tests/lib/devServer.cjs  # /api/* on :3100, proxies the rest to :3000
```

Database schema lives in `supabase/migrations/`; apply with `npm run db:migrate` (see `supabase/migrations/README.md`).

## Layout

| Path | What |
|---|---|
| `src/` | React app (`App.js` routes by page state; screens in `pages/`, shared UI in `components/`) |
| `api/` | Vercel functions, one file per route; helpers in `_utils/` and `_lib/` |
| `supabase/` | Migrations, rollbacks, PGlite migration tests |
| `tests/` | Custom Node test harness (`node tests/run-all.cjs`) |
| `scripts/` | One-off ops scripts (migration runner, token backfill) |
| `public/` | Static assets, legal pages, TikTok domain verification files |
| `docs/guides/` | Deployment, security, payments and social integration guides |
| `docs/specs/` | Feature specs |
| `docs/reports/` | Dated audit and status snapshots (historical) |

Contributor and agent conventions: [AGENTS.md](AGENTS.md).
