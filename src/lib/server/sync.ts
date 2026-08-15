import { env } from '$env/dynamic/private';
import type { SyncSummary } from '$lib/types';
import db from './db';
import { fetchAppDetails, fetchWishlistAppids, type SteamApp } from './steam';

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
	`)
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
