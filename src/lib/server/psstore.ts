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
	gameInfo: {
		name: 'conceptRetrieveForGameInfo',
		hash: '156bf37e6d6091b4d584ebf5f430a65e818b6120525dd82a0745352d21619da6'
	},
	conceptByProduct: {
		name: 'metGetConceptByProductIdQuery',
		hash: '0a4c9f3693b3604df1c8341fdc3e481f42eeecf961a996baaa65e65a657a6433'
	}
} as const;

type Operation = (typeof OPS)[keyof typeof OPS];

async function webQuery(op: Operation, variables: Record<string, string>): Promise<unknown> {
	const params = new URLSearchParams({
		operationName: op.name,
		variables: JSON.stringify(variables),
		extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: op.hash } })
	});
	const res = await fetch(`${WEB_GRAPHQL}?${params}`, {
		headers: { accept: 'application/json', 'x-psn-store-locale-override': 'en-US' }
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
	return `${average.toFixed(1)}★`;
}

/** PS release date (ISO yyyy-mm-dd), or null when unannounced. */
export async function fetchConceptReleaseDate(conceptId: string): Promise<string | null> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await webQuery(OPS.gameInfo, { conceptId: String(conceptId) })) as any;
	const value = data?.conceptRetrieve?.releaseDate?.value;
	if (!value) return null;
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) return null;
	return new Date(timestamp).toISOString().slice(0, 10);
}

/** Resolves a store product ID ("UP0102-PPSA07813_00-…") to its concept ID. */
export async function resolveProductToConcept(productId: string): Promise<string | null> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await webQuery(OPS.conceptByProduct, { productId })) as any;
	const id = data?.productRetrieve?.concept?.id;
	return id ? String(id) : null;
}
