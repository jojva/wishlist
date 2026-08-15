import { env } from '$env/dynamic/private';
import type { SyncSummary } from '$lib/types';
import db, { getMeta, setMeta } from './db';
import { lookupPsnConcepts, lookupSteamApps } from './igdb';
import { getPsnAccessToken, isPsnConfigured } from './psnAuth';
import { fetchPsnWishlist, type PsnWishlistItem } from './psnWishlist';
import {
	conceptUrl,
	fetchConceptRating,
	fetchConceptSummary,
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
	selectPsnPrimaryGames: db.prepare(
		'SELECT id, psn_concept_id FROM games WHERE psn_wishlisted = 1 AND steam_wishlisted = 0 AND psn_concept_id IS NOT NULL'
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
	setTitle: db.prepare('UPDATE games SET title = ? WHERE id = ?'),
	// PSN wishlist concept IDs are authoritative; IGDB only fills gaps.
	setIgdbData: db.prepare(
		'UPDATE games SET igdb_id = ?, psn_concept_id = COALESCE(psn_concept_id, ?) WHERE id = ?'
	),
	setPsnConcept: db.prepare('UPDATE games SET psn_concept_id = ? WHERE id = ?'),
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
				// Presentation (title/art) belongs to the wishlist the game is on:
				// PSN-primary games keep their IGDB title and PS Store box art.
				if (wishlisted.has(app.appid)) stmts.updateGameMeta.run(app.name, app.thumbnailUrl, gameId);
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

	// Concepts we don't know yet might still be games we already track via
	// Steam under a different (IGDB-supplied) concept ID — resolve through
	// IGDB's Sony-concept -> Steam-appid mapping to avoid duplicate cards.
	const known = new Set(
		(stmts.selectPsnGames.all() as { psn_concept_id: string }[]).map((r) => r.psn_concept_id)
	);
	const unknown = [...new Set(resolved.map((r) => r.conceptId))].filter((c) => !known.has(c));
	const igdbMatches = unknown.length ? await lookupPsnConcepts(unknown) : new Map();

	applyPsnData(resolved, igdbMatches, summary);
	await enrichPcAvailability();
}

const applyPsnData = db.transaction(
	(
		resolved: { item: PsnWishlistItem; conceptId: string }[],
		igdbMatches: Map<string, { steamAppid: number | null }>,
		summary: SyncSummary
	) => {
		const psnRows = stmts.selectPsnGames.all() as {
			id: number;
			psn_concept_id: string;
			steam_appid: number | null;
		}[];
		const byConcept = new Map(psnRows.map((row) => [row.psn_concept_id, row]));
		const steamRows = stmts.selectSteamGames.all() as { id: number; steam_appid: number }[];
		const bySteamAppid = new Map(steamRows.map((row) => [row.steam_appid, row.id]));

		stmts.clearAllPsnWishlisted.run();
		const seen = new Set<string>();

		for (const { item, conceptId } of resolved) {
			if (seen.has(conceptId)) continue; // several editions can share a concept
			seen.add(conceptId);

			const conceptMatch = byConcept.get(conceptId);
			const steamAppid = igdbMatches.get(conceptId)?.steamAppid;
			const steamMatchId =
				conceptMatch === undefined && steamAppid ? bySteamAppid.get(steamAppid) : undefined;
			const gameId = conceptMatch?.id ?? steamMatchId;

			if (gameId !== undefined) {
				stmts.setPsnWishlisted.run(gameId);
				// Sony's own concept ID outranks whatever IGDB supplied.
				stmts.setPsnConcept.run(conceptId, gameId);
				// Steam's landscape header images fit the cards better, so only
				// PSN-only games take their title/box art from the PS Store.
				const hasSteam = steamMatchId !== undefined || conceptMatch?.steam_appid !== null;
				if (!hasSteam) stmts.updateGameMeta.run(item.name, item.imageUrl, gameId);
				stmts.upsertPs5Availability.run(gameId, null, conceptUrl(conceptId));
			} else {
				const { lastInsertRowid } = stmts.insertPsnGame.run(item.name, item.imageUrl, conceptId);
				stmts.upsertPs5Availability.run(lastInsertRowid, null, conceptUrl(conceptId));
				summary.added++;
			}
		}
	}
);

// --- IGDB reverse enrichment (PSN concept -> PC availability + English title) --

async function enrichPcAvailability(): Promise<void> {
	const psnOnly = stmts.selectPsnOnlyGames.all() as { id: number; psn_concept_id: string }[];
	if (psnOnly.length === 0) return;

	const matches = await lookupPsnConcepts(psnOnly.map((r) => r.psn_concept_id));

	// The PS wishlist serves regional SKU names ("Metaphor: ReFantazio PS4 et
	// PS5"); IGDB's canonical English name replaces them where known.
	db.transaction(() => {
		for (const row of psnOnly) {
			const name = matches.get(row.psn_concept_id)?.name;
			if (name) stmts.setTitle.run(name, row.id);
		}
	})();

	const candidates = psnOnly.flatMap((row) => {
		const match = matches.get(row.psn_concept_id);
		return match?.steamAppids.length ? [{ id: row.id, name: match.name, appids: match.steamAppids }] : [];
	});
	if (candidates.length === 0) return;

	const apps = await fetchAppDetails([...new Set(candidates.flatMap((c) => c.appids))]);
	db.transaction(() => {
		for (const { id, name, appids } of candidates) {
			const found = appids.map((appid) => apps.get(appid)).filter((a) => a !== undefined);
			if (found.length === 0) continue;
			const best = pickBestSteamApp(found, name);
			stmts.setSteamIdentity.run(best.appid, id);
			stmts.upsertPcRow.run(id, best.releaseDate, best.score, best.storeUrl);
		}
	})();
}

/**
 * IGDB links playtests/demos/components to the same game as the main app.
 * Prefer the app whose name matches IGDB's canonical name; fall back to the
 * lowest appid (main games predate their playtests and sub-apps).
 */
function pickBestSteamApp(apps: SteamApp[], canonicalName: string | null): SteamApp {
	const normalize = (s: string) =>
		s
			.toLowerCase()
			.replace(/[™®©]/g, '')
			.replace(/\s+/g, ' ')
			.trim();
	if (canonicalName) {
		const exact = apps.find((a) => normalize(a.name) === normalize(canonicalName));
		if (exact) return exact;
	}
	return apps.reduce((a, b) => (a.appid <= b.appid ? a : b));
}

// --- PS Store data (anonymous): release dates + star ratings ------------------

async function refreshPs5Data(): Promise<void> {
	// PSN-primary games take Sony's English concept name (their wishlist and
	// IGDB names can be regional SKUs or mislabeled sub-entries) and Sony's
	// own PS release date, both from the US store.
	const psnPrimary = stmts.selectPsnPrimaryGames.all() as {
		id: number;
		psn_concept_id: string;
	}[];
	await mapConcurrent(psnPrimary, async (row) => {
		const summary = await fetchConceptSummary(row.psn_concept_id).catch(() => null);
		if (!summary) return;
		if (summary.name) stmts.setTitle.run(summary.name, row.id);
		if (summary.releaseDate) stmts.setPs5ReleaseDate.run(summary.releaseDate, row.id);
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
