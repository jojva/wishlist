export type PlatformId = 'pc' | 'ps5';

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
	platforms: PlatformInfo[];
}
