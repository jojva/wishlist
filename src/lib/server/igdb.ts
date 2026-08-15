import { env } from '$env/dynamic/private';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API_BASE = 'https://api.igdb.com/v4/';
const SOURCE_STEAM = 1;
const SOURCE_PS_STORE = 36;
const PLATFORM_PS4 = 48;
const PLATFORM_PS5 = 167;
const CHUNK_SIZE = 400; // ids per query, under IGDB's 500-result cap

export interface IgdbInfo {
	igdbId: number;
	onPlayStation: boolean;
	psReleaseDate: string | null;
	psnConceptId: string | null;
}

interface ExternalGameRow {
	game: number;
	uid: string;
}

interface GameRow {
	id: number;
	name?: string;
	platforms?: number[];
	release_dates?: { platform: number; date?: number; human?: string }[];
	external_games?: { uid: string; external_game_source: number }[];
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
	const { IGDB_CLIENT_ID, IGDB_CLIENT_SECRET } = env;
	if (!IGDB_CLIENT_ID || !IGDB_CLIENT_SECRET) {
		throw new Error('IGDB_CLIENT_ID / IGDB_CLIENT_SECRET environment variables are not set');
	}
	const res = await fetch(
		`${TOKEN_URL}?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
		{ method: 'POST' }
	);
	if (!res.ok) throw new Error(`Twitch token exchange failed with HTTP ${res.status}`);
	const body = await res.json();
	cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
	return cachedToken.token;
}

async function query<T>(endpoint: string, body: string): Promise<T[]> {
	const token = await getToken();
	const res = await fetch(API_BASE + endpoint, {
		method: 'POST',
		headers: {
			'Client-ID': env.IGDB_CLIENT_ID!,
			Authorization: `Bearer ${token}`,
			Accept: 'application/json'
		},
		body
	});
	if (!res.ok) throw new Error(`IGDB ${endpoint} query failed with HTTP ${res.status}`);
	return res.json();
}

/** Resolves Steam appids to IGDB games and their PlayStation availability. */
export async function lookupSteamApps(appids: number[]): Promise<Map<number, IgdbInfo>> {
	const result = new Map<number, IgdbInfo>();
	if (appids.length === 0) return result;

	const appidByGameId = new Map<number, number>();
	for (let i = 0; i < appids.length; i += CHUNK_SIZE) {
		const uids = appids
			.slice(i, i + CHUNK_SIZE)
			.map((id) => `"${id}"`)
			.join(',');
		const rows = await query<ExternalGameRow>(
			'external_games',
			`fields game, uid; where external_game_source = ${SOURCE_STEAM} & uid = (${uids}); limit 500;`
		);
		for (const row of rows) appidByGameId.set(row.game, Number(row.uid));
	}

	const gameIds = [...appidByGameId.keys()];
	for (let i = 0; i < gameIds.length; i += CHUNK_SIZE) {
		const ids = gameIds.slice(i, i + CHUNK_SIZE).join(',');
		const rows = await query<GameRow>(
			'games',
			`fields platforms, release_dates.platform, release_dates.date, release_dates.human,
			 external_games.uid, external_games.external_game_source; where id = (${ids}); limit 500;`
		);
		for (const row of rows) {
			const appid = appidByGameId.get(row.id);
			if (appid !== undefined) result.set(appid, toInfo(row));
		}
	}

	return result;
}

export interface PsnConceptMatch {
	igdbId: number;
	/** All Steam appids IGDB links to the game — may include playtests/demos. */
	steamAppids: number[];
	/** IGDB's canonical (English) game name. */
	name: string | null;
}

/** Resolves PS Store concept IDs to IGDB games and their Steam appid, if any. */
export async function lookupPsnConcepts(
	conceptIds: string[]
): Promise<Map<string, PsnConceptMatch>> {
	const result = new Map<string, PsnConceptMatch>();
	if (conceptIds.length === 0) return result;

	const conceptByGameId = new Map<number, string>();
	for (let i = 0; i < conceptIds.length; i += CHUNK_SIZE) {
		const uids = conceptIds
			.slice(i, i + CHUNK_SIZE)
			.map((id) => `"${id}"`)
			.join(',');
		const rows = await query<ExternalGameRow>(
			'external_games',
			`fields game, uid; where external_game_source = ${SOURCE_PS_STORE} & uid = (${uids}); limit 500;`
		);
		for (const row of rows) conceptByGameId.set(row.game, row.uid);
	}

	const gameIds = [...conceptByGameId.keys()];
	for (let i = 0; i < gameIds.length; i += CHUNK_SIZE) {
		const ids = gameIds.slice(i, i + CHUNK_SIZE).join(',');
		const rows = await query<GameRow>(
			'games',
			`fields name, external_games.uid, external_games.external_game_source; where id = (${ids}); limit 500;`
		);
		for (const row of rows) {
			const conceptId = conceptByGameId.get(row.id);
			if (conceptId === undefined) continue;
			const steamAppids = (row.external_games ?? [])
				.filter((e) => e.external_game_source === SOURCE_STEAM)
				.map((e) => Number(e.uid))
				.filter(Number.isFinite);
			result.set(conceptId, {
				igdbId: row.id,
				steamAppids,
				name: row.name?.trim() || null
			});
		}
	}

	return result;
}

function toInfo(row: GameRow): IgdbInfo {
	const platforms = row.platforms ?? [];
	const psn = row.external_games?.find((e) => e.external_game_source === SOURCE_PS_STORE);
	return {
		igdbId: row.id,
		onPlayStation: platforms.includes(PLATFORM_PS5) || platforms.includes(PLATFORM_PS4),
		psReleaseDate: psReleaseDate(row),
		psnConceptId: psn?.uid ?? null
	};
}

function psReleaseDate(row: GameRow): string | null {
	const dates = row.release_dates ?? [];
	const best =
		dates.find((d) => d.platform === PLATFORM_PS5) ??
		dates.find((d) => d.platform === PLATFORM_PS4);
	if (!best) return null;
	if (best.date) return new Date(best.date * 1000).toISOString().slice(0, 10);
	return best.human ?? null;
}
