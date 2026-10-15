// See https://svelte.dev/docs/kit/types#app.d.ts
// Cloudflare bindings are read via `import { env } from 'cloudflare:workers'`
// (adapter-cloudflare 8 / SvelteKit 3); their types come from worker-configuration.d.ts.
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
