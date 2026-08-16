<script lang="ts">
	import { flip } from 'svelte/animate';
	import { dndzone, type DndEvent } from 'svelte-dnd-action';
	import type { Game, SourceId } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The lists are client-owned after the initial load: drag & drop mutates them
	// locally and persists via the API, so we deliberately copy `data` once.
	// svelte-ignore state_referenced_locally
	let ranked = $state<Game[]>(data.ranked);
	// svelte-ignore state_referenced_locally
	let unranked = $state<Game[]>(data.unranked);
	let trayOpen = $state(false);
	let saveState = $state<'idle' | 'saving' | 'error'>('idle');

	const flipDurationMs = 150;
	const dndType = 'game';
	// On touch devices, require a 200ms hold before a drag starts so swipes scroll the page.
	const delayTouchStart = 200;

	function considerRanked(e: CustomEvent<DndEvent<Game>>) {
		ranked = e.detail.items;
	}
	function finalizeRanked(e: CustomEvent<DndEvent<Game>>) {
		ranked = e.detail.items;
		persist();
	}
	function considerTray(e: CustomEvent<DndEvent<Game>>) {
		unranked = e.detail.items;
	}
	function finalizeTray(e: CustomEvent<DndEvent<Game>>) {
		unranked = e.detail.items;
		persist();
	}

	function insertAtRank(game: Game, position: number) {
		const index = Math.max(0, Math.min(position - 1, ranked.length));
		unranked = unranked.filter((g) => g.id !== game.id);
		ranked = [...ranked.slice(0, index), game, ...ranked.slice(index)];
		persist();
	}

	async function persist() {
		saveState = 'saving';
		try {
			const res = await fetch('/api/rank', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ rankedIds: ranked.map((g) => g.id) })
			});
			saveState = res.ok ? 'idle' : 'error';
		} catch {
			saveState = 'error';
		}
	}

	let syncing = $state(false);
	let syncError = $state<string | null>(null);

	async function sync() {
		syncing = true;
		syncError = null;
		try {
			const res = await fetch('/api/sync', { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `HTTP ${res.status}`);
			}
			location.reload();
		} catch (e) {
			syncError = e instanceof Error ? e.message : 'Sync failed';
			syncing = false;
		}
	}

	const sourceLabels: Record<SourceId, string> = {
		steam: 'Steam',
		psn: 'PS Store'
	};

	function formatSyncTime(iso: string): string {
		return iso.slice(0, 16).replace('T', ' ') + ' UTC';
	}

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	/** ISO dates become Steam-style ("6 Aug, 2026"); free-form text ("Coming soon") passes through. */
	function formatDate(date: string): string {
		const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (!m) return date;
		return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}, ${m[1]}`;
	}
</script>

{#snippet cardBody(game: Game)}
	{#if game.thumbnail_url}
		<img class="thumb" src={game.thumbnail_url} alt="" loading="lazy" />
	{:else}
		<div class="thumb placeholder">🕹️</div>
	{/if}
	<div class="info">
		<div class="title-row">
			<h2>{game.title}</h2>
			{#each game.sources as source (source)}
				<span class="source {source}">{sourceLabels[source]}</span>
			{/each}
		</div>
		<div class="platforms">
			{#each game.platforms as p (p.platform)}
				<div class="platform">
					{#if p.store_url}
						<a class="chip {p.platform}" href={p.store_url} target="_blank" rel="noreferrer">
							{p.platform === 'pc' ? 'PC' : 'PS5'}
						</a>
					{:else}
						<span class="chip {p.platform}">{p.platform === 'pc' ? 'PC' : 'PS5'}</span>
					{/if}
					<span class="date">{p.release_date ? formatDate(p.release_date) : 'TBA'}</span>
					<span class="score">{p.score ?? '—'}</span>
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<svelte:head>
	<title>Wishlist</title>
</svelte:head>

<main>
	<header>
		<h1>🎮 Wishlist</h1>
		<div class="header-right">
			{#if saveState === 'saving'}
				<span class="save-status">Saving…</span>
			{:else if saveState === 'error'}
				<span class="save-status error">Save failed — reorder again to retry</span>
			{/if}
			<button class="sync" onclick={sync} disabled={syncing}>
				{syncing ? '⟳ Syncing…' : '⟳ Sync'}
			</button>
			<a class="settings-link" href="/settings" title="Settings">⚙</a>
		</div>
	</header>

	{#if syncError}
		<p class="sync-info error">Sync failed: {syncError}</p>
	{:else if data.lastSync}
		<p class="sync-info">
			Last sync {formatSyncTime(data.lastSync.at)} —
			{#if data.lastSync.error}
				failed: {data.lastSync.error}
			{:else}
				{data.lastSync.added} added, {data.lastSync.updated} updated, {data.lastSync.removed} removed{data
					.lastSync.failed
					? `, ${data.lastSync.failed} unavailable`
					: ''}{data.lastSync.ps5 !== undefined ? `, ${data.lastSync.ps5} on PS5` : ''}
			{/if}
		</p>
	{/if}

	{#if data.lastSync?.psnError}
		<p class="sync-info warn">PSN: {data.lastSync.psnError} — <a href="/settings">Settings</a></p>
	{/if}

	{#if ranked.length === 0 && unranked.length === 0}
		<p class="empty">No games yet — hit ⟳ Sync to pull your Steam wishlist.</p>
	{/if}

	{#if unranked.length > 0 || trayOpen}
		<section class="tray">
			<button class="tray-toggle" onclick={() => (trayOpen = !trayOpen)}>
				<span class="caret">{trayOpen ? '▾' : '▸'}</span>
				To be ranked
				<span class="count">{unranked.length}</span>
			</button>
			{#if trayOpen}
				<div
					class="tray-list"
					use:dndzone={{ items: unranked, flipDurationMs, type: dndType, delayTouchStart }}
					onconsider={considerTray}
					onfinalize={finalizeTray}
				>
					{#each unranked as game (game.id)}
						<div class="card in-tray" animate:flip={{ duration: flipDurationMs }}>
							{@render cardBody(game)}
							<form
								class="jump"
								onsubmit={(e) => {
									e.preventDefault();
									const pos = Number(new FormData(e.currentTarget).get('pos'));
									insertAtRank(game, pos > 0 ? pos : ranked.length + 1);
								}}
							>
								<input name="pos" type="number" min="1" max={ranked.length + 1} placeholder="#" />
								<button type="submit">Rank</button>
							</form>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}

	<section
		class="ranked-list"
		use:dndzone={{ items: ranked, flipDurationMs, type: dndType, delayTouchStart }}
		onconsider={considerRanked}
		onfinalize={finalizeRanked}
	>
		{#each ranked as game, i (game.id)}
			<div class="card" animate:flip={{ duration: flipDurationMs }}>
				<div class="rank">{i + 1}</div>
				{@render cardBody(game)}
			</div>
		{/each}
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #12151c;
		color: #e6e9ef;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			sans-serif;
	}

	main {
		max-width: 780px;
		margin: 0 auto;
		padding: 1.5rem 1rem 4rem;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.25rem;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.save-status {
		font-size: 0.8rem;
		color: #8b93a3;
	}

	.save-status.error {
		color: #ff7b72;
	}

	.sync {
		background: #1d2330;
		color: #8b93a3;
		border: 1px solid #2c3446;
		border-radius: 8px;
		padding: 0.4rem 0.9rem;
		font-size: 0.9rem;
	}

	.sync:not(:disabled) {
		cursor: pointer;
		color: #e6e9ef;
	}

	.sync:not(:disabled):hover {
		border-color: #4a5878;
	}

	.sync:disabled {
		cursor: wait;
		opacity: 0.6;
	}

	.sync-info {
		font-size: 0.8rem;
		color: #8b93a3;
		margin: -0.5rem 0 1rem;
	}

	.sync-info.error {
		color: #ff7b72;
	}

	.sync-info.warn {
		color: #e3b341;
	}

	.sync-info.warn a {
		color: #6ea8fe;
	}

	.settings-link {
		color: #8b93a3;
		text-decoration: none;
		font-size: 1.2rem;
	}

	.settings-link:hover {
		color: #e6e9ef;
	}

	.empty {
		text-align: center;
		color: #8b93a3;
		padding: 3rem 0;
	}

	.tray {
		margin-bottom: 1.5rem;
		border: 1px dashed #3a4358;
		border-radius: 12px;
		background: #171b25;
	}

	.tray-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		background: none;
		border: none;
		color: #e6e9ef;
		font-size: 1rem;
		font-weight: 600;
		padding: 0.85rem 1rem;
		cursor: pointer;
		text-align: left;
	}

	.caret {
		color: #8b93a3;
	}

	.count {
		background: #b48b2e;
		color: #12151c;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
		padding: 0.1rem 0.55rem;
	}

	.tray-list {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0 0.75rem 0.75rem;
	}

	.ranked-list {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-height: 4rem;
	}

	.card {
		display: flex;
		align-items: stretch;
		gap: 0.9rem;
		background: #1d2330;
		border: 1px solid #2c3446;
		border-radius: 12px;
		padding: 0.75rem;
		cursor: grab;
	}

	.card.in-tray {
		border-style: dashed;
	}

	.rank {
		align-self: center;
		min-width: 2.2rem;
		text-align: center;
		font-size: 1.4rem;
		font-weight: 800;
		color: #8b93a3;
	}

	.thumb {
		width: 184px;
		height: 86px;
		object-fit: cover;
		border-radius: 8px;
		flex-shrink: 0;
	}

	.thumb.placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 2rem;
		background: #12151c;
	}

	.info {
		flex: 1;
		min-width: 0;
	}

	.title-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.45rem;
	}

	h2 {
		font-size: 1.05rem;
		margin: 0;
	}

	.source {
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		border-radius: 4px;
		padding: 0.12rem 0.4rem;
	}

	.source.steam {
		background: #1b2838;
		color: #66c0f4;
	}

	.source.psn {
		background: #0f2f6b;
		color: #9bb7ff;
	}

	.platforms {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.platform {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		font-size: 0.85rem;
		color: #aeb6c4;
	}

	.date {
		white-space: nowrap;
	}

	.chip {
		font-size: 0.7rem;
		font-weight: 700;
		border-radius: 5px;
		padding: 0.15rem 0.45rem;
		min-width: 2rem;
		text-align: center;
	}

	.chip.pc {
		background: #1b3a5c;
		color: #7fc0ff;
	}

	.chip.ps5 {
		background: #16325c;
		color: #9bb7ff;
	}

	a.chip {
		text-decoration: none;
	}

	a.chip:hover {
		filter: brightness(1.35);
		text-decoration: underline;
	}

	.jump {
		align-self: center;
		display: flex;
		gap: 0.4rem;
	}

	.jump input {
		width: 3.2rem;
		background: #12151c;
		color: #e6e9ef;
		border: 1px solid #2c3446;
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
	}

	.jump button {
		background: #2b5cb8;
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 0.35rem 0.7rem;
		cursor: pointer;
	}

	/* Narrow screens: the fixed-width thumb + info row doesn't fit, so stack the
	   card — rank + full-width art on top, info (and the tray's rank form) below. */
	@media (max-width: 640px) {
		.card {
			flex-wrap: wrap;
		}

		.rank {
			min-width: 1.6rem;
			font-size: 1.15rem;
		}

		.thumb {
			flex: 1 1 auto;
			width: auto;
			height: auto;
			min-width: 0;
			aspect-ratio: 460 / 215;
		}

		.info {
			flex-basis: 100%;
		}

		.jump {
			flex-basis: 100%;
		}
	}
</style>
