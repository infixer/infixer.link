/**
 * HTTP client for the owner API with a Bearer token (ADR 0016).
 *
 * - The token is only ever sent to the configured site origin; media downloads from
 *   another origin (the R2 custom domain) never carry it.
 * - Network failures are retried. A mutation is always retried with the same body,
 *   so the same mutationId: the server applies it once and replays the result.
 * - Error messages never include the token or page bodies.
 */
import type { ApiErrorBody } from '@infixer-link/contracts';
import { CliError, EXIT } from './errors.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
	baseUrl: string;
	token?: string;
	fetch?: Fetch;
	/** Delays between retries of network failures (ms). */
	retryDelays?: number[];
	sleep?: (ms: number) => Promise<void>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https only, except for local development servers. */
export function checkBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new CliError(`URL が正しくありません: ${raw}`, EXIT.usage);
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
		throw new CliError('URL は https:// で指定してください（localhost を除く）', EXIT.usage);
	}
	return url.origin;
}

function exitFor(status: number, code?: string) {
	if (status === 401 || status === 403) return EXIT.auth;
	if (status === 404) return EXIT.notFound;
	if (code === 'revision_conflict' || code === 'page_deleted' || code === 'mutation_conflict')
		return EXIT.conflict;
	return EXIT.error;
}

export class Api {
	readonly origin: string;
	private readonly token?: string;
	private readonly fetchFn: Fetch;
	private readonly retryDelays: number[];
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: ApiOptions) {
		this.origin = checkBaseUrl(options.baseUrl);
		this.token = options.token;
		this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
		this.retryDelays = options.retryDelays ?? [500, 2000, 5000];
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	/** JSON request. `auth: false` for public endpoints. */
	async request<T>(
		method: string,
		path: string,
		options: { body?: unknown; auth?: boolean } = {}
	): Promise<T> {
		const auth = options.auth ?? true;
		if (auth && !this.token) {
			throw new CliError(
				'トークンがありません。INFIXER_TOKEN を設定するか `infixer auth login` を実行してください',
				EXIT.auth
			);
		}
		const headers: Record<string, string> = { accept: 'application/json' };
		if (auth) headers.authorization = `Bearer ${this.token}`;
		if (options.body !== undefined) headers['content-type'] = 'application/json';
		const init: RequestInit = {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body)
		};
		const res = await this.withRetry(() => this.fetchFn(`${this.origin}${path}`, init));
		if (res.ok) return (await res.json()) as T;
		const error = (await res.json().catch(() => null)) as ApiErrorBody | null;
		const message =
			res.status === 401
				? 'トークンが無効か期限切れです'
				: (error?.message ?? `HTTP ${res.status}`);
		throw new CliError(message, exitFor(res.status, error?.code), error?.code);
	}

	/** Raw request with a body (image upload). */
	async send(method: string, path: string, body: Uint8Array, contentType: string) {
		const res = await this.withRetry(() =>
			this.fetchFn(`${this.origin}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					'content-type': contentType
				},
				body: body as BodyInit
			})
		);
		if (!res.ok) {
			const error = (await res.json().catch(() => null)) as ApiErrorBody | null;
			throw new CliError(error?.message ?? `HTTP ${res.status}`, exitFor(res.status, error?.code));
		}
		return res.json();
	}

	/** Downloads a public file (e.g. an image). The token is never sent. */
	async download(url: string): Promise<Uint8Array> {
		const absolute = new URL(url, this.origin);
		if (absolute.protocol !== 'https:' && absolute.origin !== this.origin) {
			throw new CliError(`安全でない URL です: ${absolute.origin}`, EXIT.error);
		}
		const res = await this.withRetry(() => this.fetchFn(absolute.toString()));
		if (!res.ok)
			throw new CliError(`ダウンロードに失敗しました（HTTP ${res.status}）`, EXIT.network);
		return new Uint8Array(await res.arrayBuffer());
	}

	private async withRetry(run: () => Promise<Response>): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			try {
				const res = await run();
				// Gateway errors are as transient as a dropped connection.
				if (
					(res.status === 502 || res.status === 503 || res.status === 504) &&
					attempt < this.retryDelays.length
				) {
					await this.sleep(this.retryDelays[attempt]!);
					continue;
				}
				return res;
			} catch {
				if (attempt >= this.retryDelays.length) {
					throw new CliError(`${this.origin} に接続できません`, EXIT.network);
				}
				await this.sleep(this.retryDelays[attempt]!);
			}
		}
	}
}
