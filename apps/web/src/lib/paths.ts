/** URL helpers shared by server and browser code. */

/** Display-only slug; the page id is the identifier (design §3.1). */
export function pageSlug(title: string): string {
	return encodeURIComponent(title.trim().replace(/\s+/g, '_')).slice(0, 120);
}

export function pagePath(page: { id: string; title: string }): string {
	return `/p/${page.id}/${pageSlug(page.title)}`;
}

/** Only same-origin absolute paths are allowed as post-login destinations. */
export function safeReturnTo(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\'))
		return '/';
	try {
		const url = new URL(value, 'https://placeholder.invalid');
		if (url.origin !== 'https://placeholder.invalid') return '/';
		return url.pathname + url.search + url.hash;
	} catch {
		return '/';
	}
}
