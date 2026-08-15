<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Settings — Wishlist</title>
</svelte:head>

<main>
	<header>
		<h1>Settings</h1>
		<a href="/">← Back to wishlist</a>
	</header>

	<section>
		<h2>PlayStation Network</h2>
		<p class="status">
			{#if data.npsso}
				NPSSO saved on {data.npsso.savedAt.slice(0, 10)}. Sony expires it roughly every 2 months —
				paste a fresh one here when the sync starts complaining.
			{:else}
				No NPSSO configured yet — the PSN wishlist won't sync until you add one.
			{/if}
		</p>

		<ol>
			<li>Log in at <a href="https://www.playstation.com" target="_blank" rel="noreferrer">playstation.com</a></li>
			<li>
				Open
				<a href="https://ca.account.sony.com/api/v1/ssocookie" target="_blank" rel="noreferrer">
					ca.account.sony.com/api/v1/ssocookie
				</a>
			</li>
			<li>Copy the 64-character <code>npsso</code> value and paste it below.</li>
		</ol>

		<form
			method="POST"
			action="?/npsso"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}
		>
			<input type="password" name="npsso" placeholder="Paste NPSSO token" required autocomplete="off" />
			<button disabled={submitting}>{submitting ? 'Validating…' : 'Save'}</button>
		</form>

		{#if form?.error}
			<p class="message error">{form.error}</p>
		{:else if form?.success}
			<p class="message success">NPSSO saved and validated — PSN sync is ready.</p>
		{/if}
	</section>
</main>

<style>
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

	header a {
		color: #6ea8fe;
		text-decoration: none;
	}

	header a:hover {
		text-decoration: underline;
	}

	section {
		background: #1d2330;
		border: 1px solid #2c3446;
		border-radius: 12px;
		padding: 1rem 1.25rem 1.25rem;
	}

	h2 {
		font-size: 1.1rem;
		margin: 0 0 0.5rem;
	}

	.status {
		color: #aeb6c4;
		font-size: 0.9rem;
	}

	ol {
		color: #aeb6c4;
		font-size: 0.9rem;
		padding-left: 1.2rem;
	}

	ol a {
		color: #6ea8fe;
	}

	code {
		background: #12151c;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
	}

	form {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	input {
		flex: 1;
		background: #12151c;
		color: #e6e9ef;
		border: 1px solid #2c3446;
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		font-size: 0.9rem;
	}

	button {
		background: #2b5cb8;
		color: #fff;
		border: none;
		border-radius: 8px;
		padding: 0.5rem 1rem;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.message {
		font-size: 0.9rem;
		margin: 0.75rem 0 0;
	}

	.message.error {
		color: #ff7b72;
	}

	.message.success {
		color: #7ee08a;
	}
</style>
