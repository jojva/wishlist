import db from '$lib/server/db';
import { getLastSync } from '$lib/server/sync';
import type { Game, PlatformInfo, SourceId } from '$lib/types';
import type { PageServerLoad } from './$types';

type GameRow = Omit<Game, 'platforms' | 'sources'> & { steam_appid: number | null };
type PlatformRow = PlatformInfo & { game_id: number };

export const load: PageServerLoad = () => {
	const gameRows = db
		.prepare('SELECT id, title, thumbnail_url, rank, steam_appid FROM games')
		.all() as GameRow[];
	const platformRows = db
		.prepare(
			'SELECT game_id, platform, release_date, score, store_url FROM game_platforms ORDER BY platform'
		)
		.all() as PlatformRow[];

	const games: Game[] = gameRows.map(({ steam_appid, ...row }) => {
		const sources: SourceId[] = [];
		if (steam_appid !== null) sources.push('steam');
		return { ...row, sources, platforms: [] };
	});
	const byId = new Map(games.map((g) => [g.id, g]));
	for (const { game_id, ...platform } of platformRows) {
		byId.get(game_id)?.platforms.push(platform);
	}

	return {
		ranked: games.filter((g) => g.rank !== null).sort((a, b) => a.rank! - b.rank!),
		unranked: games.filter((g) => g.rank === null).sort((a, b) => a.title.localeCompare(b.title)),
		lastSync: getLastSync()
	};
};
