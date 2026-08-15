// Sony serves the store page to browser user agents only.
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function conceptUrl(conceptId: string): string {
	return `https://store.playstation.com/en-fr/concept/${conceptId}`;
}

/** Star rating (e.g. "4.6★") from the public concept page, or null when unavailable. */
export async function fetchConceptRating(conceptId: string): Promise<string | null> {
	const res = await fetch(conceptUrl(conceptId), {
		headers: { 'user-agent': USER_AGENT },
		redirect: 'follow'
	});
	if (!res.ok) return null;
	const html = await res.text();
	const average = html.match(/"averageRating":([0-9.]+)/);
	const count = html.match(/"totalRatingsCount":"?([0-9]+)"?/);
	if (!average || !count || Number(count[1]) === 0) return null;
	return `${Number(average[1]).toFixed(1)}★`;
}
