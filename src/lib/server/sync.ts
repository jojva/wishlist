import { env } from '$env/dynamic/private';
import type { SyncSummary } from '$lib/types';
import db from './db';
import { lookupSteamApps } from './igdb';
import { conceptUrl, fetchConceptRating } from './psstore';
import { fetchAppDetails, fetchWishlistAppids, type SteamApp } from './steam';

const RATING_CONCURRENCY = 4;

const stmts = {
	saveLastSync: db.prepare(
		"INSERT INTO meta (key, value) VALUES ('last_sync', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
	),
	getLastSync: db.prepare("SELECT value FROM meta WHERE key = 'last_sync'"),
	selectSteamGames: db.prepare('SELECT id, steam_appid FROM games WHERE steam_appid IS NOT NULL'),
	deleteGame: db.prepare('DELETE FROM games WHERE id = ?'),
	insertGame: db.prepare('INSERT INTO games (title, thumbnail_url, steam_appid) VALUES (?, ?, ?)'),
	updateGame: db.prepare('UPDATE games SET title = ?, thumbnail_url = ? WHERE id = ?'),
	upsertPcRow: db.prepare(`
		INSERT INTO game_platforms (game_id, platform, release_date, score, store_url)
		VALUES (?, 'pc', ?, ?, ?)
		ON CONFLICT (game_id, platform) DO UPDATE SET
			release_date = excluded.release_date,
			score = excluded.score,
			store_url = excluded.store_url
	`),
	setIgdbData: db.prepare('UPDATE games SET igdb_id = ?, psn_concept_id = ? WHERE id = ?'),
	upsertPs5Row: db.prepare(`
		INSERT INTO game_platforms (game_id, platform, release_date, score, store_url)
		VALUES (?, 'ps5', ?, ?, ?)
		ON CONFLICT (game_id, platform) DO UPDATE SET
			release_date = excluded.release_date,
			score = excluded.score,
			store_url = excluded.store_url
	`),
	deletePs5Row: db.prepare("DELETE FROM game_platforms WHERE game_id = ? AND platform = 'ps5'")
};

let running: Promise<SyncSummary> | null = null;

/** Coalesces concurrent callers (button spam, cron overlap) into a single run. */
export function runSteamSync(): Promise<SyncSummary> {
	running ??= doSync().finally(() => (running = null));
	return running;
}

export function getLastSync(): SyncSummary | null {
	const row = stmts.getLastSync.get() as { value: string } | undefined;
	return row ? (JSON.parse(row.value) as SyncSummary) : null;
}

async function doSync(): Promise<SyncSummary> {
	const summary: SyncSummary = {
		at: new Date().toISOString(),
		added: 0,
		updated: 0,
		removed: 0,
		failed: 0
	};

	try {
		const steamId = env.STEAM_ID;
		if (!steamId) throw new Error('STEAM_ID environment variable is not set');

		const appids = await fetchWishlistAppids(steamId);
		const apps = await fetchAppDetails(appids);
		summary.failed = appids.length - apps.size;
		applySteamData(apps, new Set(appids), summary);
		await enrichPlayStation(summary);
	} catch (e) {
		summary.error = e instanceof Error ? e.message : String(e);
	}

	stmts.saveLastSync.run(JSON.stringify(summary));
	if (summary.error) throw new Error(summary.error);
	return summary;
}

const applySteamData = db.transaction(
	(apps: Map<number, SteamApp>, wishlisted: Set<number>, summary: SyncSummary) => {
		const existing = stmts.selectSteamGames.all() as { id: number; steam_appid: number }[];
		const gameIdByAppid = new Map(existing.map((row) => [row.steam_appid, row.id]));

		// A game on neither wishlist is removed. Until PSN sync exists, leaving
		// the Steam wishlist means leaving both. (Once PSN membership exists,
		// this must clear steam_appid instead when the game is still on PSN.)
		for (const row of existing) {
			if (wishlisted.has(row.steam_appid)) continue;
			stmts.deleteGame.run(row.id);
			summary.removed++;
		}

		for (const app of apps.values()) {
			const gameId = gameIdByAppid.get(app.appid);
			if (gameId === undefined) {
				// New games arrive unranked, i.e. in the "To be ranked" tray.
				const { lastInsertRowid } = stmts.insertGame.run(app.name, app.thumbnailUrl, app.appid);
				stmts.upsertPcRow.run(lastInsertRowid, app.releaseDate, app.score, app.storeUrl);
				summary.added++;
			} else {
				stmts.updateGame.run(app.name, app.thumbnailUrl, gameId);
				stmts.upsertPcRow.run(gameId, app.releaseDate, app.score, app.storeUrl);
				summary.updated++;
			}
		}
	}
);

/**
 * Determines PS4/PS5 availability for every Steam-synced game via IGDB's
 * exact appid mapping, then fills ps5 platform rows (release date, PS Store
 * star rating, concept link). Games IGDB doesn't know stay untouched.
 */
async function enrichPlayStation(summary: SyncSummary): Promise<void> {
	const rows = stmts.selectSteamGames.all() as { id: number; steam_appid: number }[];
	const infos = await lookupSteamApps(rows.map((r) => r.steam_appid));

	const onPlayStation: { id: number; psReleaseDate: string | null; conceptId: string | null }[] =
		[];
	for (const row of rows) {
		const info = infos.get(row.steam_appid);
		if (!info) continue;
		stmts.setIgdbData.run(info.igdbId, info.psnConceptId, row.id);
		if (info.onPlayStation) {
			onPlayStation.push({ id: row.id, psReleaseDate: info.psReleaseDate, conceptId: info.psnConceptId });
		} else {
			stmts.deletePs5Row.run(row.id);
		}
	}
	summary.ps5 = onPlayStation.length;

	// Star ratings come from the public store pages; fetch a few at a time.
	for (let i = 0; i < onPlayStation.length; i += RATING_CONCURRENCY) {
		const batch = onPlayStation.slice(i, i + RATING_CONCURRENCY);
		const ratings = await Promise.all(
			batch.map((g) => (g.conceptId ? fetchConceptRating(g.conceptId).catch(() => null) : null))
		);
		batch.forEach((game, j) => {
			stmts.upsertPs5Row.run(
				game.id,
				game.psReleaseDate,
				ratings[j],
				game.conceptId ? conceptUrl(game.conceptId) : null
			);
		});
	}
}
