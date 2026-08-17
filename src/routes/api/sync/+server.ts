import { error, json } from '@sveltejs/kit';
import { getSyncProgress, runSteamSync } from '$lib/server/sync';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		return json(await runSteamSync());
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'Sync failed');
	}
};

/** Live progress of the in-flight sync (null when idle) — polled by the Sync button. */
export const GET: RequestHandler = () => {
	return json({ progress: getSyncProgress() });
};
