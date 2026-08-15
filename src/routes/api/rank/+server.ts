import db from '$lib/server/db';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const clearRanks = db.prepare('UPDATE games SET rank = NULL');
const setRank = db.prepare('UPDATE games SET rank = ? WHERE id = ?');

const applyOrder = db.transaction((rankedIds: number[]) => {
	clearRanks.run();
	rankedIds.forEach((id, index) => setRank.run(index + 1, id));
});

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const rankedIds: unknown = body?.rankedIds;

	if (
		!Array.isArray(rankedIds) ||
		!rankedIds.every((id) => Number.isInteger(id)) ||
		new Set(rankedIds).size !== rankedIds.length
	) {
		error(400, 'rankedIds must be an array of unique integers');
	}

	applyOrder(rankedIds as number[]);
	return json({ ok: true });
};
