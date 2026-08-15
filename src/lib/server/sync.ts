import { env } from '$env/dynamic/private';
import type { SyncSummary } from '$lib/types';
import db, { getMeta, setMeta } from './db';
import { lookupPsnConcepts, lookupSteamApps } from './igdb';
import { getPsnAccessToken, isPsnConfigured } from './psnAuth';
import { fetchPsnWishlist, type PsnWishlistItem } from './psnWishlist';
import {
	conceptUrl,
	fetchConceptRating,
	fetchConceptReleaseDate,
	resolveProductToConcept
} from './psstore';
import { fetchAppDetails, fetchWishlistAppids, type SteamApp } from './steam';

const CONCURRENCY = 4;
const LAST_SYNC_KEY = 'last_sync';

const stmts = {
	selectSteamGames: db.prepare(
		'SELECT id, steam_appid, psn_wishlisted FROM games WHERE steam_appid IS NOT NULL'
	),
	selectPsnGames: db.prepare(
		'SELECT id, psn_concept_id, steam_appid FROM games WHERE psn_concept_id IS NOT NULL'
	),
	selectPsnOnlyGames: db.prepare(
		'SELECT id, psn_concept_id FROM games WHERE psn_concept_id IS NOT NULL AND steam_appid IS NULL'
	),
	selectRatableGames: db.prepare(`
		SELECT g.id, g.psn_concept_id FROM games g
		JOIN game_platforms p ON p.game_id = g.id AND p.platform = 'ps5'
		WHERE g.psn_concept_id IS NOT NULL
	`),
	countPs5Rows: db.prepare("SELECT COUNT(*) AS n FROM game_platforms WHERE platform = 'ps5'"),
	setSteamWishlisted: db.prepare('UPDATE games SET steam_wishlisted = ? WHERE id = ?'),
	setPsnWishlisted: db.prepare('UPDATE games SET psn_wishlisted = 1 WHERE id = ?'),
	clearAllPsnWishlisted: db.prepare('UPDATE games SET psn_wishlisted = 0'),
	insertSteamGame: db.prepare(
		'INSERT INTO games (title, thumbnail_url, steam_appid, steam_wishlisted) VALUES (?, ?, ?, 1)'
	),
	insertPsnGame: db.prepare(
		'INSERT INTO games (title, thumbnail_url, psn_concept_id, psn_wishlisted) VALUES (?, ?, ?, 1)'
	),
	updateGameMeta: db.prepare('UPDATE games SET title = ?, thumbnail_url = ? WHERE id = ?'),
	// PSN wishlist concept IDs are authoritative; IGDB only fills gaps.
	setIgdbData: db.prepare(
		'UPDATE games SET igdb_id = ?, psn_concept_id = COALESCE(psn_concept_id, ?) WHERE id = ?'
	),
	setSteamIdentity: db.prepare('UPDATE games SET steam_appid = ? WHERE id = ?'),
	deleteOrphans: db.prepare('DELETE FROM games WHERE steam_wishlisted = 0 AND psn_wishlisted = 0'),
	upsertPcRow: db.prepare(`
		INSERT INTO game_platforms (game_id, platform, release_date, score, store_url)
		VALUES (?, 'pc', ?, ?, ?)
		ON CONFLICT (game_id, platform) DO UPDATE SET
			release_date = excluded.release_date,
			score = excluded.score,
			store_url = excluded.store_url
	`),
	// Availability only: never clobbers an existing date/URL with null, and
	// leaves the score column to the dedicated ratings pass.
	upsertPs5Availability: db.prepare(`
		INSERT INTO game_platforms (game_id, platform, release_date, score, store_url)
		VALUES (?, 'ps5', ?, NULL, ?)
		ON CONFLICT (game_id, platform) DO UPDATE SET
			release_date = COALESCE(excluded.release_date, release_date),
			store_url = COALESCE(excluded.store_url, store_url)
	`),
	deletePs5Row: db.prepare("DELETE FROM game_platforms WHERE game_id = ? AND platform = 'ps5'"),
	setPs5ReleaseDate: db.prepare(
		"UPDATE game_platforms SET release_date = ? WHERE game_id = ? AND platform = 'ps5'"
	),
	setPs5Score: db.prepare(
		"UPDATE game_platforms SET score = ? WHERE game_id = ? AND platform = 'ps5'"
	)
};

let running: Promise<SyncSummary> | null = null;

/** Coalesces concurrent callers (button spam, cron overlap) into a single run. */
export function runSteamSync(): Promise<SyncSummary> {
	running ??= doSync().finally(() => (running = null));
	return running;
}

export function getLastSync(): SyncSummary | null {
	const raw = getMeta(LAST_SYNC_KEY);
	return raw ? (JSON.parse(raw) as SyncSummary) : null;
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
		await syncSteam(summary);
		await enrichPlayStationAvailability();

		try {
			await syncPsnWishlist(summary);
		} catch (e) {
			summary.psnError = e instanceof Error ? e.message : String(e);
		}

		await refreshPs5Data();
		summary.removed = stmts.deleteOrphans.run().changes;
		summary.ps5 = (stmts.countPs5Rows.get() as { n: number }).n;
	} catch (e) {
		summary.error = e instanceof Error ? e.message : String(e);
	}

	setMeta(LAST_SYNC_KEY, JSON.stringify(summary));
	if (summary.error) throw new Error(summary.error);
	return summary;
}

// --- Steam ------------------------------------------------------------------

async function syncSteam(summary: SyncSummary): Promise<void> {
	const steamId = env.STEAM_ID;
	if (!steamId) throw new Error('STEAM_ID environment variable is not set');

	const wishlisted = new Set(await fetchWishlistAppids(steamId));
	// Also refresh games that carry a Steam identity without being on the
	// Steam wishlist (e.g. PSN-wishlisted games that exist on Steam).
	const identities = stmts.selectSteamGames.all() as { id: number; steam_appid: number }[];
	const allAppids = [...new Set([...wishlisted, ...identities.map((r) => r.steam_appid)])];

	const apps = await fetchAppDetails(allAppids);
	summary.failed += allAppids.length - apps.size;
	applySteamData(apps, wishlisted, summary);
}

const applySteamData = db.transaction(
	(apps: Map<number, SteamApp>, wishlisted: Set<number>, summary: SyncSummary) => {
		const existing = stmts.selectSteamGames.all() as { id: number; steam_appid: number }[];
		const gameIdByAppid = new Map(existing.map((row) => [row.steam_appid, row.id]));

		for (const row of existing) {
			stmts.setSteamWishlisted.run(wishlisted.has(row.steam_appid) ? 1 : 0, row.id);
		}

		for (const app of apps.values()) {
			const gameId = gameIdByAppid.get(app.appid);
			if (gameId === undefined) {
				if (!wishlisted.has(app.appid)) continue;
				// New games arrive unranked, i.e. in the "To be ranked" tray.
				const { lastInsertRowid } = stmts.insertSteamGame.run(app.name, app.thumbnailUrl, app.appid);
				stmts.upsertPcRow.run(lastInsertRowid, app.releaseDate, app.score, app.storeUrl);
				summary.added++;
			} else {
				stmts.updateGameMeta.run(app.name, app.thumbnailUrl, gameId);
				stmts.upsertPcRow.run(gameId, app.releaseDate, app.score, app.storeUrl);
				summary.updated++;
			}
		}
	}
);

// --- IGDB enrichment (Steam identity -> PlayStation availability) ------------

async function enrichPlayStationAvailability(): Promise<void> {
	const rows = stmts.selectSteamGames.all() as {
		id: number;
		steam_appid: number;
		psn_wishlisted: number;
	}[];
	const infos = await lookupSteamApps(rows.map((r) => r.steam_appid));

	db.transaction(() => {
		for (const row of rows) {
			const info = infos.get(row.steam_appid);
			if (!info) continue; // unknown to IGDB — leave untouched
			stmts.setIgdbData.run(info.igdbId, info.psnConceptId, row.id);
			if (info.onPlayStation) {
				stmts.upsertPs5Availability.run(
					row.id,
					info.psReleaseDate,
					info.psnConceptId ? conceptUrl(info.psnConceptId) : null
				);
			} else if (!row.psn_wishlisted) {
				// IGDB says not on PlayStation — but the PSN wishlist outranks it.
				stmts.deletePs5Row.run(row.id);
			}
		}
	})();
}

// --- PSN wishlist -------------------------------------------------------------

async function syncPsnWishlist(summary: SyncSummary): Promise<void> {
	if (!isPsnConfigured()) {
		summary.psnError = 'NPSSO not set — add it in Settings';
		return;
	}

	const token = await getPsnAccessToken();
	const items = await fetchPsnWishlist(token);

	// Released products need a product -> concept resolution (anonymous query).
	const resolved: { item: PsnWishlistItem; conceptId: string }[] = [];
	await mapConcurrent(items, async (item) => {
		const conceptId = item.isConcept
			? item.id
			: await resolveProductToConcept(item.id).catch(() => null);
		if (conceptId) resolved.push({ item, conceptId });
		else summary.failed++;
	});

	applyPsnData(resolved, summary);
	await enrichPcAvailability();
}

const applyPsnData = db.transaction(
	(resolved: { item: PsnWishlistItem; conceptId: string }[], summary: SyncSummary) => {
		const existing = stmts.selectPsnGames.all() as {
			id: number;
			psn_concept_id: string;
			steam_appid: number | null;
		}[];
		const byConcept = new Map(existing.map((row) => [row.psn_concept_id, row]));

		stmts.clearAllPsnWishlisted.run();
		const seen = new Set<string>();

		for (const { item, conceptId } of resolved) {
			if (seen.has(conceptId)) continue; // several editions can share a concept
			seen.add(conceptId);

			const match = byConcept.get(conceptId);
			if (match) {
				stmts.setPsnWishlisted.run(match.id);
				// Steam's landscape header images fit the cards better, so only
				// PSN-only games take their title/box art from the PS Store.
				if (match.steam_appid === null) stmts.updateGameMeta.run(item.name, item.imageUrl, match.id);
				stmts.upsertPs5Availability.run(match.id, null, conceptUrl(conceptId));
			} else {
				const { lastInsertRowid } = stmts.insertPsnGame.run(item.name, item.imageUrl, conceptId);
				stmts.upsertPs5Availability.run(lastInsertRowid, null, conceptUrl(conceptId));
				summary.added++;
			}
		}
	}
);

// --- IGDB reverse enrichment (PSN concept -> PC availability) -----------------

async function enrichPcAvailability(): Promise<void> {
	const psnOnly = stmts.selectPsnOnlyGames.all() as { id: number; psn_concept_id: string }[];
	if (psnOnly.length === 0) return;

	const matches = await lookupPsnConcepts(psnOnly.map((r) => r.psn_concept_id));
	const withSteam = psnOnly.flatMap((row) => {
		const appid = matches.get(row.psn_concept_id)?.steamAppid;
		return appid ? [{ id: row.id, appid }] : [];
	});
	if (withSteam.length === 0) return;

	const apps = await fetchAppDetails(withSteam.map((x) => x.appid));
	db.transaction(() => {
		for (const { id, appid } of withSteam) {
			const app = apps.get(appid);
			if (!app) continue;
			stmts.setSteamIdentity.run(appid, id);
			stmts.upsertPcRow.run(id, app.releaseDate, app.score, app.storeUrl);
		}
	})();
}

// --- PS Store data (anonymous): release dates + star ratings ------------------

async function refreshPs5Data(): Promise<void> {
	// Steam-identified games get their PS date from IGDB; PSN-only games
	// need it from the store's game-info slice.
	const psnOnly = stmts.selectPsnOnlyGames.all() as { id: number; psn_concept_id: string }[];
	await mapConcurrent(psnOnly, async (row) => {
		const date = await fetchConceptReleaseDate(row.psn_concept_id).catch(() => null);
		if (date) stmts.setPs5ReleaseDate.run(date, row.id);
	});

	const ratable = stmts.selectRatableGames.all() as { id: number; psn_concept_id: string }[];
	await mapConcurrent(ratable, async (row) => {
		const score = await fetchConceptRating(row.psn_concept_id).catch(() => null);
		// Null can mean "no ratings yet" or a transient failure — keep the old value.
		if (score) stmts.setPs5Score.run(score, row.id);
	});
}

async function mapConcurrent<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	for (let i = 0; i < items.length; i += CONCURRENCY) {
		await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
	}
}
