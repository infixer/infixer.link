/**
 * Adjusts the Content-Security-Policy produced by SvelteKit (design §9.8). Pure function.
 *
 * - Production: SvelteKit puts the per-request nonce only into script-src. CodeMirror
 *   injects its base styles as <style nonce> (EditorView.cspNonce), so the same nonce is
 *   added to style-src; without it the caret and selection layers lose their positioning.
 * - Development: SvelteKit allows styles with 'unsafe-inline' because Vite injects <style>
 *   tags without a nonce. Adding a nonce or hash there would make browsers ignore
 *   'unsafe-inline' and block every style, so style-src is left untouched.
 * - The media origin (R2 custom domain) is allowed for images (ADR 0012).
 */
export function adjustCsp(csp: string, mediaBaseUrl: string | undefined): string {
	let out = csp;
	const styleSrc = /style-src ([^;]*)/.exec(out)?.[1] ?? '';
	const nonce = /'nonce-([^']+)'/.exec(out)?.[1];
	if (nonce && !styleSrc.includes("'unsafe-inline'") && !styleSrc.includes("'nonce-")) {
		out = out.replace(/style-src ([^;]*)/, `style-src $1 'nonce-${nonce}'`);
	}
	if (mediaBaseUrl?.startsWith('https://')) {
		out = out.replace(/img-src ([^;]*)/, `img-src $1 ${new URL(mediaBaseUrl).origin}`);
	}
	return out;
}
