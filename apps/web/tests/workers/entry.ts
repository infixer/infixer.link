// Minimal Worker entry for integration tests so they do not depend on the
// SvelteKit build output (wrangler.jsonc `main`). Tests call services / the Hono app directly.
export default {
	fetch: () => new Response('test entry', { status: 404 })
} satisfies ExportedHandler;
