import { fail } from '@sveltejs/kit';
import { getNpssoStatus, getPsnAccessToken, saveNpsso } from '$lib/server/psnAuth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ npsso: getNpssoStatus() });

export const actions: Actions = {
	npsso: async ({ request }) => {
		const form = await request.formData();
		const value = String(form.get('npsso') ?? '').trim();
		if (!/^[A-Za-z0-9]{40,100}$/.test(value)) {
			return fail(400, { error: 'That does not look like an NPSSO token (expected ~64 alphanumeric characters).' });
		}
		saveNpsso(value);
		try {
			await getPsnAccessToken();
		} catch (e) {
			return fail(400, {
				error: `Saved, but Sony rejected it: ${e instanceof Error ? e.message : e}`
			});
		}
		return { success: true };
	}
};
