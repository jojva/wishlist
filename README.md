# Wishlist

A single-user, no-auth web app that merges a personal **Steam wishlist** and **PSN wishlist** into one drag-and-drop-ranked list of games. Each game is cross-referenced across both stores: availability, release date, and score on PC and PS5, whichever wishlist it came from.

Runs on a personal VPS behind nginx.

## How it works

A sync pipeline (manual button + daily 06:00 cron) pulls from four sources:

- **Steam** — wishlist appids and store metadata, via public keyless endpoints.
- **IGDB** — bridges the two ecosystems: maps Steam appids to PSN concept IDs and vice versa, so a game wishlisted on one store still shows its availability on the other.
- **PSN** — the authenticated wishlist, via the mobile GraphQL API (psn-api for auth).
- **PS Store** — English concept names, PS5 release dates, and star ratings, via anonymous persisted queries.

Games land in a "To be ranked" tray, then get dragged into the ranked list. Every drop persists the full order.

## Stack

SvelteKit (Svelte 5 runes) · SQLite (better-sqlite3) · svelte-dnd-action · node-cron · adapter-node in Docker behind nginx.

## Running locally

```sh
npm install
cp .env.example .env   # fill in the values below
npm run dev
```

`.env`:

| Variable | What it is |
| --- | --- |
| `STEAM_ID` | 64-bit Steam ID of the wishlist to sync (profile must be public) |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | Twitch developer app credentials ([dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)) — IGDB authenticates through Twitch |
| `ORIGIN` | Public origin the app is served at (adapter-node needs it for form POSTs; not needed for local dev) |
| `DEPLOY_HOST` | SSH destination `deploy.sh` ships to (deploy only) |

The PSN token is **not** an env var: paste a fresh NPSSO token into the Settings page (it's validated immediately and stored in the database). It expires every couple of months; the sync summary tells you when it needs replacing.

The SQLite database is created at `data/wishlist.db` on first run.

`npm run check` typechecks the project — the only verification step; there are no tests.

## Deploying

```sh
./deploy.sh
```

Requires a clean tree on `main`. Pushes to GitHub, then pulls and rebuilds on the VPS (`docker compose up -d --build`), and health-checks the deployed SHA against local. The container binds to localhost only; nginx terminates TLS in front. The `data/` directory is volume-mounted so the database survives rebuilds.

## Development notes

Architecture details (data model, sync pipeline order and precedence rules, per-store API quirks) are documented in [CLAUDE.md](CLAUDE.md).
