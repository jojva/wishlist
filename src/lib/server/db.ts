import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'wishlist.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Numbered schema migrations; PRAGMA user_version tracks the last applied one.
const migrations = [
	// 1: initial schema (kept so DBs created before migrations existed land on
	// the same version number; the tables it creates are rebuilt by 2).
	`
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
	`,
	// 2: wishlist provenance + Steam sync support. Rebuilds from scratch —
	// only throwaway demo seed data existed before this version.
	`
	DROP TABLE IF EXISTS game_platforms;
	DROP TABLE IF EXISTS games;
	CREATE TABLE games (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL,
		thumbnail_url TEXT,
		rank INTEGER,
		steam_appid INTEGER UNIQUE,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE TABLE game_platforms (
		game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
		platform TEXT NOT NULL CHECK (platform IN ('pc', 'ps5')),
		source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('steam', 'psn', 'manual')),
		release_date TEXT,
		score TEXT,
		store_url TEXT,
		PRIMARY KEY (game_id, platform)
	);
	CREATE TABLE meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	`,
	// 3: decorrelate platforms from wishlists. Platform rows now describe
	// where a game exists (availability + metadata); wishlist membership
	// lives on games (steam_appid, later a PSN id). Manual entries are
	// dropped as a concept, so the source column goes away entirely.
	`
	CREATE TABLE game_platforms_new (
		game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
		platform TEXT NOT NULL CHECK (platform IN ('pc', 'ps5')),
		release_date TEXT,
		score TEXT,
		store_url TEXT,
		PRIMARY KEY (game_id, platform)
	);
	INSERT INTO game_platforms_new (game_id, platform, release_date, score, store_url)
		SELECT game_id, platform, release_date, score, store_url FROM game_platforms;
	DROP TABLE game_platforms;
	ALTER TABLE game_platforms_new RENAME TO game_platforms;
	`,
	// 4: PS5 availability enrichment via IGDB (igdb_id caches the mapping,
	// psn_concept_id identifies the game on the PS Store).
	`
	ALTER TABLE games ADD COLUMN igdb_id INTEGER;
	ALTER TABLE games ADD COLUMN psn_concept_id TEXT;
	`,
	// 5: explicit wishlist-membership flags. steam_appid / psn_concept_id
	// are pure store identities from here on; membership (and the source
	// badges) live in these flags, and a game is removed only when both are 0.
	`
	ALTER TABLE games ADD COLUMN steam_wishlisted INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE games ADD COLUMN psn_wishlisted INTEGER NOT NULL DEFAULT 0;
	UPDATE games SET steam_wishlisted = 1 WHERE steam_appid IS NOT NULL;
	`
];

const applied = db.pragma('user_version', { simple: true }) as number;
for (let version = applied; version < migrations.length; version++) {
	db.transaction(() => {
		db.exec(migrations[version]);
		db.pragma(`user_version = ${version + 1}`);
	})();
}

const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
const metaSet = db.prepare(
	'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
);
const metaDelete = db.prepare('DELETE FROM meta WHERE key = ?');

export function getMeta(key: string): string | null {
	return (metaGet.get(key) as { value: string } | undefined)?.value ?? null;
}

export function setMeta(key: string, value: string): void {
	metaSet.run(key, value);
}

export function deleteMeta(key: string): void {
	metaDelete.run(key);
}

export default db;
