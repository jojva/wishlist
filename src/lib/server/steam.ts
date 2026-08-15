const WISHLIST_URL = 'https://api.steampowered.com/IWishlistService/GetWishlist/v1/';
const GET_ITEMS_URL = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
const ASSET_BASE = 'https://shared.cloudflare.steamstatic.com/store_item_assets/';
const CHUNK_SIZE = 50;

export interface SteamApp {
	appid: number;
	name: string;
	thumbnailUrl: string | null;
	releaseDate: string | null;
	score: string | null;
	storeUrl: string;
}

interface StoreItem {
	appid: number;
	success: number;
	name?: string;
	store_url_path?: string;
	assets?: { asset_url_format?: string; header?: string };
	release?: { steam_release_date?: number; custom_release_date_message?: string };
	reviews?: {
		summary_filtered?: {
			review_count?: number;
			percent_positive?: number;
			review_score_label?: string;
		};
	};
}

export async function fetchWishlistAppids(steamId: string): Promise<number[]> {
	const res = await fetch(`${WISHLIST_URL}?steamid=${encodeURIComponent(steamId)}`);
	if (!res.ok) throw new Error(`Steam wishlist request failed with HTTP ${res.status}`);
	const body = await res.json();
	const items: unknown = body?.response?.items;
	if (!Array.isArray(items)) throw new Error('Unexpected Steam wishlist response shape');
	// An empty list is far more likely a transient API failure than a
	// deliberately emptied wishlist — refuse rather than wipe every game.
	if (items.length === 0) throw new Error('Steam wishlist came back empty — refusing to sync');
	return items.map((item: { appid: number }) => item.appid);
}

/** Batch-fetches store metadata. Delisted/hidden apps are absent from the result. */
export async function fetchAppDetails(appids: number[]): Promise<Map<number, SteamApp>> {
	const apps = new Map<number, SteamApp>();

	for (let i = 0; i < appids.length; i += CHUNK_SIZE) {
		const chunk = appids.slice(i, i + CHUNK_SIZE);
		const input = {
			ids: chunk.map((appid) => ({ appid })),
			context: { language: 'english', country_code: 'FR' },
			data_request: { include_assets: true, include_release: true, include_reviews: true }
		};
		const res = await fetch(`${GET_ITEMS_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`);
		if (!res.ok) throw new Error(`Steam GetItems request failed with HTTP ${res.status}`);
		const body = await res.json();
		const items: StoreItem[] = body?.response?.store_items ?? [];

		for (const item of items) {
			if (item.success !== 1 || !item.name) continue;
			apps.set(item.appid, {
				appid: item.appid,
				name: item.name,
				thumbnailUrl: thumbnailUrl(item),
				releaseDate: releaseDate(item),
				score: score(item),
				storeUrl: item.store_url_path
					? `https://store.steampowered.com/${item.store_url_path}`
					: `https://store.steampowered.com/app/${item.appid}/`
			});
		}
	}

	return apps;
}

function thumbnailUrl(item: StoreItem): string {
	const { asset_url_format, header } = item.assets ?? {};
	if (asset_url_format && header) {
		return ASSET_BASE + asset_url_format.replace('${FILENAME}', header);
	}
	return `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/header.jpg`;
}

function releaseDate(item: StoreItem): string | null {
	const timestamp = item.release?.steam_release_date;
	if (timestamp) return new Date(timestamp * 1000).toISOString().slice(0, 10);
	// Unreleased games often carry a free-form message like "Coming 2026".
	return item.release?.custom_release_date_message || null;
}

function score(item: StoreItem): string | null {
	const summary = item.reviews?.summary_filtered;
	if (!summary?.review_count || summary.percent_positive === undefined) return null;
	const label = summary.review_score_label;
	return `${summary.percent_positive}%${label ? ` ${label}` : ''}`;
}
