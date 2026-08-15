export type PlatformId = 'pc' | 'ps5';

export type SourceId = 'steam' | 'psn' | 'manual';

export interface PlatformInfo {
	platform: PlatformId;
	source: SourceId;
	release_date: string | null;
	score: string | null;
	store_url: string | null;
}

export interface Game {
	id: number;
	title: string;
	thumbnail_url: string | null;
	rank: number | null;
	platforms: PlatformInfo[];
}

export interface SyncSummary {
	at: string;
	added: number;
	updated: number;
	removed: number;
	failed: number;
	error?: string;
}
