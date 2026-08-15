// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { DndEvent } from 'svelte-dnd-action';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	// Custom events dispatched by svelte-dnd-action's dndzone action
	namespace svelteHTML {
		interface HTMLAttributes<T> {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			onconsider?: (event: CustomEvent<DndEvent<any>> & { target: EventTarget & T }) => void;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			onfinalize?: (event: CustomEvent<DndEvent<any>> & { target: EventTarget & T }) => void;
		}
	}
}

export {};
