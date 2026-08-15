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
	`
];

const applied = db.pragma('user_version', { simple: true }) as number;
for (let version = applied; version < migrations.length; version++) {
	db.transaction(() => {
		db.exec(migrations[version]);
		db.pragma(`user_version = ${version + 1}`);
	})();
}

export default db;
