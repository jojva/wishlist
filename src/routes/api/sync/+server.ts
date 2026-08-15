import { error, json } from '@sveltejs/kit';
import { runSteamSync } from '$lib/server/sync';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		return json(await runSteamSync());
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'Sync failed');
	}
};
