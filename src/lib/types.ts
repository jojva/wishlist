export type PlatformId = 'pc' | 'ps5';

export type SourceId = 'steam' | 'psn';

export interface PlatformInfo {
	platform: PlatformId;
	release_date: string | null;
	score: string | null;
	store_url: string | null;
}

export interface Game {
	id: number;
	title: string;
	thumbnail_url: string | null;
	rank: number | null;
	/** Which wishlists the game is on — independent from platform availability. */
	sources: SourceId[];
	platforms: PlatformInfo[];
}

export interface SyncSummary {
	at: string;
	added: number;
	updated: number;
	removed: number;
	failed: number;
	/** Games confirmed available on PS4/PS5 during enrichment. */
	ps5?: number;
	error?: string;
}
