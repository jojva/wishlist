# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-user, no-auth web app that merges a personal Steam wishlist and PSN wishlist into one drag-and-drop-ranked list of games, cross-referencing each game's availability, release date, and score on both PC and PS5. Runs on a VPS behind nginx (public origin and deploy target are configured in `.env`, not checked in).

## Commands

- `npm run dev` — dev server
- `npm run build` — production build (adapter-node, outputs to `build/`)
- `npm run check` — typecheck via svelte-check (`check:watch` for watch mode). This is the only verification step: there are no tests and no linter.
- `./deploy.sh` — full deploy: pushes `main`, pulls + `docker compose up -d --build` on the VPS, then health-checks. Requires a clean tree on `main`.

Config comes from `.env` (see `.env.example`): `STEAM_ID`, `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET` (Twitch dev app credentials). The PSN NPSSO token is *not* an env var — it's pasted into the Settings page and stored in the DB's `meta` table.

## Stack notes

- Svelte 5 **runes mode is forced** for all project files via `vite.config.ts` (libraries excluded) — always use `$state`/`$props`/`$derived`, never legacy reactivity.
- SQLite via better-sqlite3 (synchronous API), DB file at `data/wishlist.db` (gitignored, volume-mounted in Docker).

## Architecture

### Data model (`src/lib/server/db.ts`)

Schema changes are numbered migrations in the `migrations` array, tracked by `PRAGMA user_version`. **Append a new migration; never edit an existing one.**

The core invariant: **store identity and wishlist membership are decorrelated.**

- `games` holds identities (`steam_appid`, `psn_concept_id`, `igdb_id`), membership flags (`steam_wishlisted`, `psn_wishlisted`), presentation (title, thumbnail), and `rank` (NULL = in the "To be ranked" tray).
- `game_platforms` (`pc`/`ps5`) describes *where a game exists* — release date, score, store URL — independent of which wishlist it's on. A Steam-only wishlist game can have a `ps5` row and vice versa.
- A game is deleted only when **both** wishlisted flags are 0.
- `meta` is a key-value table: last sync summary, NPSSO token, cached PSN OAuth tokens.

### Sync pipeline (`src/lib/server/sync.ts`)

The heart of the app. `runSteamSync()` coalesces concurrent callers into one run (button spam, cron overlap). Pipeline order matters:

1. **Steam sync** — fetch wishlist appids + store metadata, upsert `pc` rows.
2. **IGDB enrichment** — Steam appid → IGDB game → PlayStation availability + PSN concept ID; upserts `ps5` rows.
3. **PSN wishlist sync** — failures here are isolated into `summary.psnError` so Steam data stays fresh (the NPSSO expires periodically). Matches incoming concepts against known games (via concept ID, then via IGDB's concept→Steam-appid mapping) to avoid duplicate cards.
4. **Reverse IGDB enrichment** — PSN-only games get PC availability + a Steam identity.
5. **PS Store refresh** — English concept names and PS release dates (US store) for PSN-primary games; star ratings for everything with a `ps5` row.
6. Delete orphans (neither flag set).

Precedence rules baked into the pipeline:

- Sony's own concept IDs (from the PSN wishlist) outrank IGDB-supplied ones.
- Title/box-art belongs to the "primary" wishlist: Steam-wishlisted games use Steam name + landscape header art; PSN-primary games use Sony's US-store English concept name + PS Store box art (PSN wishlist names are regional SKUs like "… PS4 et PS5").
- Upserts use COALESCE so a null from one source never clobbers data from another; the ratings pass alone owns the `ps5.score` column.
- **An empty wishlist response (Steam or PSN) is treated as an error, not truth** — refusing to sync beats wiping every game on a transient API failure.

A daily 06:00 sync is registered in `src/hooks.server.ts` via node-cron (globalThis flag guards against dev-HMR double-registration; `TZ=Europe/Paris` is set in docker-compose).

### External API clients (`src/lib/server/`)

One file per service, each encoding hard-won quirks — read the comments before touching request shapes:

- `steam.ts` — public (keyless) Steam endpoints; batched GetItems calls.
- `igdb.ts` — Twitch client-credentials OAuth, cached token; bidirectional Steam-appid ↔ IGDB ↔ PSN-concept mapping via `external_games`.
- `psnAuth.ts` — NPSSO → code → access/refresh tokens (psn-api), persisted in `meta`.
- `psnWishlist.ts` — authenticated persisted GraphQL query on the *mobile* PSN host; needs the `apollographql-client-name` and `apollo-require-preflight` headers (Apollo CSRF rejects plain GETs with 400).
- `psstore.ts` — anonymous persisted queries on the *web* PS Store host; only pre-registered query hashes work. Locale matters: `fr-FR` to resolve French-store (EP-prefixed) product IDs, `en-US` for English names/dates.

### Frontend

Single page (`src/routes/+page.svelte`) with two svelte-dnd-action zones: the ranked list and a collapsible "To be ranked" tray. After the initial load the lists are client-owned state; every drop POSTs the full order to `/api/rank`, which rewrites all ranks in one transaction. `/api/sync` triggers a manual sync. `/settings` handles NPSSO entry (validated by an immediate token exchange).
