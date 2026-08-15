import db from '$lib/server/db';
import type { Game, PlatformInfo } from '$lib/types';
import type { PageServerLoad } from './$types';

type GameRow = Omit<Game, 'platforms'>;
type PlatformRow = PlatformInfo & { game_id: number };

export const load: PageServerLoad = () => {
	const gameRows = db.prepare('SELECT id, title, thumbnail_url, rank FROM games').all() as GameRow[];
	const platformRows = db
		.prepare(
			'SELECT game_id, platform, release_date, score, store_url FROM game_platforms ORDER BY platform'
		)
		.all() as PlatformRow[];

	const games: Game[] = gameRows.map((row) => ({ ...row, platforms: [] }));
	const byId = new Map(games.map((g) => [g.id, g]));
	for (const { game_id, ...platform } of platformRows) {
		byId.get(game_id)?.platforms.push(platform);
	}

	return {
		ranked: games.filter((g) => g.rank !== null).sort((a, b) => a.rank! - b.rank!),
		unranked: games.filter((g) => g.rank === null).sort((a, b) => a.title.localeCompare(b.title))
	};
};
