/** Link card metadata: safe fetching, extraction, caching (ADR 0010). */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/lib/server/api/app';
import {
	checkFetchable,
	extractMeta,
	fetchPreview,
	isForbiddenHost
} from '../../src/lib/server/previews';
import { ApiClient, config, resetDb } from '../helpers/api-client';

const HTML = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="記事のタイトル &amp; more">
<meta property="og:description" content="  説明文
  です ">
<meta property="og:site_name" content="Example">
<meta property="og:image" content="/img/card.png">
</head><body>[本文]</body></html>`;

function fakeFetcher(routes: Record<string, () => Response>) {
	const calls: string[] = [];
	const fetcher = async (input: string) => {
		calls.push(input);
		const route = routes[input];
		return route ? route() : new Response('not found', { status: 404 });
	};
	return { calls, fetcher };
}

const html =
	(body = HTML) =>
	() =>
		new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('host and URL checks', () => {
	it('refuses private, loopback and non-http targets', () => {
		for (const host of [
			'localhost',
			'127.0.0.1',
			'10.1.2.3',
			'192.168.0.1',
			'172.20.0.1',
			'169.254.169.254',
			'[::1]',
			'intranet',
			'printer.local'
		]) {
			expect(isForbiddenHost(host)).toBe(true);
		}
		expect(isForbiddenHost('example.org')).toBe(false);
		expect(checkFetchable('ftp://example.org', false)).toBeNull();
		expect(checkFetchable('https://user:pw@example.org', false)).toBeNull();
		expect(checkFetchable('https://example.org:8443/', false)).toBeNull();
		expect(checkFetchable('http://localhost:4173/x', true)).not.toBeNull();
	});
});

describe('extraction', () => {
	it('prefers OGP, decodes entities, collapses whitespace, resolves the image', async () => {
		expect(extractMeta(HTML).title).toBe('記事のタイトル &amp; more');
		const { fetcher } = fakeFetcher({ 'https://example.org/a': html() });
		const p = await fetchPreview('https://example.org/a', { fetcher, allowLocal: false });
		expect(p).toMatchObject({
			status: 'ok',
			title: '記事のタイトル & more',
			description: '説明文 です',
			site_name: 'Example',
			image_url: 'https://example.org/img/card.png'
		});
	});

	it('follows safe redirects but refuses a redirect into a private network', async () => {
		const { fetcher, calls } = fakeFetcher({
			'https://example.org/r': () =>
				new Response(null, { status: 302, headers: { location: '/final' } }),
			'https://example.org/final': html(),
			'https://example.org/evil': () =>
				new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } })
		});
		expect(
			(await fetchPreview('https://example.org/r', { fetcher, allowLocal: false })).title
		).toBe('記事のタイトル & more');
		expect(
			(await fetchPreview('https://example.org/evil', { fetcher, allowLocal: false })).status
		).toBe('error');
		expect(calls).not.toContain('http://169.254.169.254/latest');
	});

	it('does not parse non-HTML responses and caps oversized bodies', async () => {
		const big = '<html><head><title>' + 'x'.repeat(600 * 1024) + '</title></head></html>';
		const { fetcher } = fakeFetcher({
			'https://example.org/pdf': () =>
				new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
			'https://example.org/big': html(big)
		});
		expect(
			await fetchPreview('https://example.org/pdf', { fetcher, allowLocal: false })
		).toMatchObject({
			status: 'ok',
			title: null
		});
		const p = await fetchPreview('https://example.org/big', { fetcher, allowLocal: false });
		expect(p.title).toBeNull(); // closing </title> is beyond the 512 KiB read limit
	});
});

describe('owner endpoint and cache', () => {
	beforeEach(resetDb);

	it('fetches once, caches, and serves cached data without refetching', async () => {
		const { fetcher, calls } = fakeFetcher({ 'https://example.org/a': html() });
		const owner = new ApiClient(createApi({ db: env.DB, config, fetcher }));
		await owner.setupOwner();
		const first = await owner.json('/api/owner/v1/link-previews', {
			body: { urls: ['https://example.org/a'] }
		});
		expect(first.body.previews['https://example.org/a']).toMatchObject({
			ok: true,
			title: '記事のタイトル & more',
			host: 'example.org'
		});
		await owner.json('/api/owner/v1/link-previews', { body: { urls: ['https://example.org/a'] } });
		expect(calls).toHaveLength(1);
	});

	it('is owner-only and validates input', async () => {
		const anon = new ApiClient();
		expect(
			(await anon.json('/api/owner/v1/link-previews', { body: { urls: ['https://example.org'] } }))
				.status
		).toBe(401);
		const owner = new ApiClient();
		await owner.setupOwner();
		expect(
			(await owner.json('/api/owner/v1/link-previews', { body: { urls: ['javascript:alert(1)'] } }))
				.status
		).toBe(422);
		expect(
			(
				await owner.json('/api/owner/v1/link-previews', {
					body: { urls: Array(21).fill('https://e.org') }
				})
			).status
		).toBe(422);
	});
});
