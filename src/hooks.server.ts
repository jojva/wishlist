import { building } from '$app/environment';
import { schedule } from 'node-cron';
import { runSteamSync } from '$lib/server/sync';

// Daily wishlist sync at 06:00 server time. The globalThis flag guards
// against re-registration when dev-mode HMR reloads this module.
const g = globalThis as typeof globalThis & { __wishlistCronStarted?: boolean };
if (!building && !g.__wishlistCronStarted) {
	g.__wishlistCronStarted = true;
	schedule('0 6 * * *', () => {
		runSteamSync().catch((e) => console.error('[cron] Steam sync failed:', e));
	});
}
