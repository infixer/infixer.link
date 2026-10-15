/** Page commands: get / search / today / append / put / create (design §13.1). */
import type {
	DailyPageDto,
	MutationResult,
	OwnerPageDto,
	ResolveDto,
	SearchDto
} from '@infixer-link/contracts';
import type { Api } from './api.ts';
import { CliError, EXIT } from './errors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NewId = () => string;

/** A page id, "today", or a title / alias. */
export async function resolveTarget(
	api: Api,
	target: string,
	options: { createToday?: boolean; newId?: NewId } = {}
): Promise<string> {
	if (UUID_RE.test(target)) return target.toLowerCase();
	if (target === 'today') {
		const existing = await api
			.request<{ pageId: string }>('GET', '/api/owner/v1/daily/today')
			.catch((error: unknown) => {
				if (error instanceof CliError && error.exitCode === EXIT.notFound) return null;
				throw error;
			});
		if (existing) return existing.pageId;
		if (!options.createToday) {
			throw new CliError('今日の日記はまだありません（--create で作成できます）', EXIT.notFound);
		}
		const created = await api.request<DailyPageDto>('POST', '/api/owner/v1/daily/today', {
			body: { mutationId: (options.newId ?? (() => crypto.randomUUID()))() }
		});
		return created.pageId;
	}
	try {
		const found = await api.request<ResolveDto>(
			'GET',
			`/api/public/v1/resolve?title=${encodeURIComponent(target)}`,
			{ auth: false }
		);
		return found.pageId;
	} catch (error) {
		if (error instanceof CliError && error.exitCode === EXIT.notFound) {
			throw new CliError(`「${target}」というページはありません`, EXIT.notFound);
		}
		throw error;
	}
}

export function getPage(api: Api, id: string) {
	return api.request<OwnerPageDto>('GET', `/api/owner/v1/pages/${id}`);
}

export function search(api: Api, query: string, limit?: number) {
	const q = `q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ''}`;
	return api.request<SearchDto>('GET', `/api/public/v1/search?${q}`, {
		auth: false
	});
}

/** Appends text as new line(s) at the end (design §13.1: read → update with baseRevision). */
export function appendText(source: string, text: string): string {
	const addition = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
	if (!source) return addition;
	return `${source.replace(/\n+$/, '')}\n${addition}`;
}

/**
 * Appends once. Network retries reuse the same mutationId (Api retries the same body).
 * A newer revision on the server is a conflict: nothing is re-appended automatically.
 */
export async function append(
	api: Api,
	id: string,
	text: string,
	newId: NewId = () => crypto.randomUUID()
): Promise<MutationResult> {
	const page = await getPage(api, id);
	if (page.deletedAt) throw new CliError('このページは削除されています', EXIT.conflict);
	return update(api, id, {
		baseRevision: page.revision,
		title: page.title,
		source: appendText(page.source, text),
		mutationId: newId()
	});
}

export async function update(
	api: Api,
	id: string,
	input: {
		baseRevision: number;
		title: string;
		source: string;
		mutationId: string;
	}
): Promise<MutationResult> {
	try {
		return await api.request<MutationResult>('PUT', `/api/owner/v1/pages/${id}`, {
			body: {
				...input,
				format: 'link-text-v1',
				source: input.source.replace(/\r\n?/g, '\n')
			}
		});
	} catch (error) {
		if (error instanceof CliError && error.code === 'revision_conflict') {
			throw new CliError(
				`ページが先に更新されていました（版 ${input.baseRevision} から変わっています）。内容を確認してからもう一度実行してください`,
				EXIT.conflict,
				error.code
			);
		}
		throw error;
	}
}

export function create(
	api: Api,
	input: {
		title: string;
		source: string;
		mutationId: string;
		id?: string;
		dailyDate?: string;
	}
) {
	return api.request<MutationResult>('POST', '/api/owner/v1/pages', {
		body: {
			...input,
			format: 'link-text-v1',
			source: input.source.replace(/\r\n?/g, '\n')
		}
	});
}
