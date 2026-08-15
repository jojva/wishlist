// The wishlist persisted query lives on the mobile-app GraphQL host and
// needs a Bearer token plus the PlayStation App client-name header.
const MOBILE_GRAPHQL = 'https://m.np.playstation.com/api/graphql/v1/op';
const WISHLIST_OPERATION = 'metGetStoreWishlist';
const WISHLIST_HASH = '571149e8aa4d76af7dd33b92e1d6f8f828ebc5fa8f0f6bf51a8324a0e6d71324';

export interface PsnWishlistItem {
	/** Concept ID for unreleased concepts, product ID for released products. */
	id: string;
	isConcept: boolean;
	name: string;
	imageUrl: string | null;
}

interface RawItem {
	__typename?: string;
	id?: string | number;
	name?: string;
	boxArt?: { url?: string };
}

/** The whole wishlist comes back in one request — Sony does not page it. */
export async function fetchPsnWishlist(accessToken: string): Promise<PsnWishlistItem[]> {
	const params = new URLSearchParams({
		operationName: WISHLIST_OPERATION,
		variables: '{}',
		extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: WISHLIST_HASH } })
	});
	const res = await fetch(`${MOBILE_GRAPHQL}?${params}`, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			'apollographql-client-name': 'PlayStationApp-Android',
			// Apollo's CSRF prevention rejects "simple" GETs with HTTP 400
			// unless this header forces a preflight-class request.
			'apollo-require-preflight': 'true',
			'accept-language': 'en-US',
			accept: 'application/json'
		}
	});
	if (!res.ok) throw new Error(`PSN wishlist request failed with HTTP ${res.status}`);
	const body = await res.json();
	if (body.errors?.length) {
		throw new Error(`PSN wishlist: ${body.errors[0]?.message ?? 'GraphQL error'}`);
	}
	const items: RawItem[] | undefined = body?.data?.storeWishlist;
	if (!Array.isArray(items)) throw new Error('Unexpected PSN wishlist response shape');
	// Same reasoning as the Steam guard: an empty wishlist is more likely a
	// transient failure than reality — refuse rather than unflag everything.
	if (items.length === 0) throw new Error('PSN wishlist came back empty — refusing to sync');

	return items
		.filter((item) => item.id !== undefined && item.name)
		.map((item) => ({
			id: String(item.id),
			isConcept: item.__typename === 'Concept',
			name: item.name!,
			imageUrl: item.boxArt?.url ?? null
		}));
}
