import {
	exchangeCodeForAccessToken,
	exchangeNpssoForCode,
	exchangeRefreshTokenForAuthTokens,
	type AuthTokensResponse
} from 'psn-api';
import { deleteMeta, getMeta, setMeta } from './db';

const NPSSO_KEY = 'psn_npsso';
const TOKENS_KEY = 'psn_tokens';

interface StoredTokens {
	accessToken: string;
	accessExpiresAt: number;
	refreshToken: string;
	refreshExpiresAt: number;
}

export function saveNpsso(npsso: string): void {
	setMeta(NPSSO_KEY, JSON.stringify({ value: npsso, savedAt: new Date().toISOString() }));
	deleteMeta(TOKENS_KEY); // force a fresh exchange
}

export function getNpssoStatus(): { savedAt: string } | null {
	const raw = getMeta(NPSSO_KEY);
	if (!raw) return null;
	const { savedAt } = JSON.parse(raw) as { savedAt: string };
	return { savedAt };
}

export function isPsnConfigured(): boolean {
	return getMeta(NPSSO_KEY) !== null;
}

/** Returns a valid PSN access token, refreshing or re-authenticating as needed. */
export async function getPsnAccessToken(): Promise<string> {
	const stored = readTokens();
	if (stored && stored.accessExpiresAt > Date.now() + 60_000) return stored.accessToken;

	if (stored && stored.refreshExpiresAt > Date.now() + 60_000) {
		try {
			return saveTokens(await exchangeRefreshTokenForAuthTokens(stored.refreshToken));
		} catch {
			// refresh token rejected — fall through to a full NPSSO exchange
		}
	}

	const raw = getMeta(NPSSO_KEY);
	if (!raw) throw new Error('NPSSO not set — add it in Settings');
	const { value } = JSON.parse(raw) as { value: string };

	let code: string;
	try {
		code = await exchangeNpssoForCode(value);
	} catch {
		throw new Error('NPSSO rejected by Sony — it likely expired; paste a fresh one in Settings');
	}
	return saveTokens(await exchangeCodeForAccessToken(code));
}

function readTokens(): StoredTokens | null {
	const raw = getMeta(TOKENS_KEY);
	return raw ? (JSON.parse(raw) as StoredTokens) : null;
}

function saveTokens(auth: AuthTokensResponse): string {
	const tokens: StoredTokens = {
		accessToken: auth.accessToken,
		accessExpiresAt: Date.now() + auth.expiresIn * 1000,
		refreshToken: auth.refreshToken,
		refreshExpiresAt: Date.now() + auth.refreshTokenExpiresIn * 1000
	};
	setMeta(TOKENS_KEY, JSON.stringify(tokens));
	return tokens.accessToken;
}
