import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'wishlist.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
	CREATE TABLE IF NOT EXISTS games (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL,
		thumbnail_url TEXT,
		rank INTEGER,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE TABLE IF NOT EXISTS game_platforms (
		game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
		platform TEXT NOT NULL CHECK (platform IN ('pc', 'ps5')),
		release_date TEXT,
		score TEXT,
		store_url TEXT,
		PRIMARY KEY (game_id, platform)
	);
`);

seedIfEmpty();

type SeedPlatform = {
	platform: 'pc' | 'ps5';
	release_date: string | null;
	score: string | null;
	store_url: string | null;
};

function seedIfEmpty() {
	const { n } = db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
	if (n > 0) return;

	const seed: Array<{
		title: string;
		thumbnail_url: string | null;
		rank: number | null;
		platforms: SeedPlatform[];
	}> = [
		{
			title: 'Hades II',
			thumbnail_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1145350/header.jpg',
			rank: 1,
			platforms: [
				{
					platform: 'pc',
					release_date: '2025-09-25',
					score: '93% Overwhelmingly Positive',
					store_url: 'https://store.steampowered.com/app/1145350/Hades_II/'
				},
				{
					platform: 'ps5',
					release_date: null,
					score: null,
					store_url: 'https://store.playstation.com/en-fr/search/hades%20II'
				}
			]
		},
		{
			title: 'Clair Obscur: Expedition 33',
			thumbnail_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1903340/header.jpg',
			rank: 2,
			platforms: [
				{
					platform: 'pc',
					release_date: '2025-04-24',
					score: '95% Overwhelmingly Positive',
					store_url: 'https://store.steampowered.com/app/1903340/Clair_Obscur_Expedition_33/'
				},
				{
					platform: 'ps5',
					release_date: '2025-04-24',
					score: '4.8★',
					store_url: 'https://store.playstation.com/en-fr/search/clair%20obscur'
				}
			]
		},
		{
			title: "Baldur's Gate 3",
			thumbnail_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1086940/header.jpg',
			rank: 3,
			platforms: [
				{
					platform: 'pc',
					release_date: '2023-08-03',
					score: '96% Overwhelmingly Positive',
					store_url: 'https://store.steampowered.com/app/1086940/Baldurs_Gate_3/'
				},
				{
					platform: 'ps5',
					release_date: '2023-09-06',
					score: '4.7★',
					store_url: 'https://store.playstation.com/en-fr/search/baldur%27s%20gate%203'
				}
			]
		},
		{
			title: 'Hollow Knight: Silksong',
			thumbnail_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1030300/header.jpg',
			rank: null,
			platforms: [
				{
					platform: 'pc',
					release_date: '2025-09-04',
					score: '92% Very Positive',
					store_url: 'https://store.steampowered.com/app/1030300/Hollow_Knight_Silksong/'
				},
				{
					platform: 'ps5',
					release_date: '2025-09-04',
					score: '4.5★',
					store_url: 'https://store.playstation.com/en-fr/search/silksong'
				}
			]
		},
		{
			title: 'Ghost of Yōtei',
			thumbnail_url: null,
			rank: null,
			platforms: [
				{
					platform: 'ps5',
					release_date: '2025-10-02',
					score: '4.6★',
					store_url: 'https://store.playstation.com/en-fr/search/ghost%20of%20yotei'
				}
			]
		}
	];

	const insertGame = db.prepare('INSERT INTO games (title, thumbnail_url, rank) VALUES (?, ?, ?)');
	const insertPlatform = db.prepare(
		'INSERT INTO game_platforms (game_id, platform, release_date, score, store_url) VALUES (?, ?, ?, ?, ?)'
	);

	db.transaction(() => {
		for (const game of seed) {
			const { lastInsertRowid } = insertGame.run(game.title, game.thumbnail_url, game.rank);
			for (const p of game.platforms) {
				insertPlatform.run(lastInsertRowid, p.platform, p.release_date, p.score, p.store_url);
			}
		}
	})();
}

export default db;
