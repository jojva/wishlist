// Anonymous persisted queries on the PS Store's web GraphQL host. Sony only
// accepts operations whose sha256 hash is pre-registered; these were
// community-documented and verified live in 2026 (see psn-client-ruby docs).
const WEB_GRAPHQL = 'https://web.np.playstation.com/api/graphql/v1/op';

const OPS = {
	// "Retrive" is Sony's typo, not ours.
	conceptRating: {
		name: 'wcaConceptStarRatingRetrive',
		hash: 'e12dc5cef72296a437b4d71e0b130010bf3707ab981b585ba00d1d5773ce2092'
	},
	gameTitle: {
		name: 'conceptRetrieveForGameTitle',
		hash: 'd244286e38044363f1fb6707f719d41558c74542fc421503a38124ca87068812'
	},
	conceptByProduct: {
		name: 'metGetConceptByProductIdQuery',
		hash: '0a4c9f3693b3604df1c8341fdc3e481f42eeecf961a996baaa65e65a657a6433'
	}
} as const;

type Operation = (typeof OPS)[keyof typeof OPS];

// fr-FR by default: the wishlist holds French-store (EP-prefixed) product IDs,
// which only resolve in the matching store region. en-US is used where we
// specifically want English-localized content.
async function webQuery(
	op: Operation,
	variables: Record<string, string>,
	locale = 'fr-FR'
): Promise<unknown> {
	const params = new URLSearchParams({
		operationName: op.name,
		variables: JSON.stringify(variables),
		extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: op.hash } })
	});
	const res = await fetch(`${WEB_GRAPHQL}?${params}`, {
		headers: {
			accept: 'application/json',
			// Apollo's CSRF prevention rejects "simple" GETs with HTTP 400
			// unless this header forces a preflight-class request.
			'apollo-require-preflight': 'true',
			'accept-language': locale,
			'x-psn-store-locale-override': locale
		}
	});
	if (!res.ok) throw new Error(`PS Store ${op.name} failed with HTTP ${res.status}`);
	const body = await res.json();
	if (body.errors?.length) {
		throw new Error(`PS Store ${op.name}: ${body.errors[0]?.message ?? 'GraphQL error'}`);
	}
	return body.data;
}

export function conceptUrl(conceptId: string): string {
	return `https://store.playstation.com/en-fr/concept/${conceptId}`;
}

/** Star rating (e.g. "4.6★"), or null when the concept has no ratings. */
export async function fetchConceptRating(conceptId: string): Promise<string | null> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await webQuery(OPS.conceptRating, { conceptId: String(conceptId) })) as any;
	const rating = data?.conceptRetrieve?.defaultProduct?.starRating;
	const average = Number(rating?.averageRating);
	if (!rating?.totalRatingsCount || !Number.isFinite(average)) return null;
	return `${average.toFixed(2)}★`;
}

/** English (US-store) concept name and PS release date. */
export async function fetchConceptSummary(
	conceptId: string
): Promise<{ name: string | null; releaseDate: string | null }> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await webQuery(OPS.gameTitle, { conceptId: String(conceptId) }, 'en-US')) as any;
	const concept = data?.conceptRetrieve;
	const rawDate = concept?.releaseDate?.value ?? concept?.releaseDate;
	const timestamp = typeof rawDate === 'string' ? Date.parse(rawDate) : NaN;
	return {
		name: typeof concept?.name === 'string' ? cleanConceptName(concept.name) : null,
		releaseDate: Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10)
	};
}

/** Sony concept names sometimes carry platform suffixes ("… PS4 & PS5"). */
function cleanConceptName(name: string): string | null {
	return (
		name
			.trim()
			.replace(/\s*[-–—:]?\s*(for\s+)?PS4(™)?\s*(&|and|et)\s*PS5(™)?\s*$/i, '')
			.trim() || null
	);
}

/** Resolves a store product ID ("UP0102-PPSA07813_00-…") to its concept ID. */
export async function resolveProductToConcept(productId: string): Promise<string | null> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await webQuery(OPS.conceptByProduct, { productId })) as any;
	const id = data?.productRetrieve?.concept?.id;
	return id ? String(id) : null;
}
