/**
 * Page persistence (design §7.3, ADR 0002).
 *
 * Every mutation is one conditional INSERT/UPDATE on `pages` with RETURNING;
 * triggers maintain history, change feed, names, links, assets and search
 * atomically. Success is judged by RETURNING rows, never `meta.changes`.
 * Results are rebuilt from the history row of the mutation, so a replayed
 * request returns the original outcome.
 */
import type {
	CreatePageRequest,
	DailyPageDto,
	DeletePageRequest,
	MutationResult,
	OwnerPageDto,
	PageDto,
	PageListDto,
	ResolveDto,
	RestorePageRequest,
	RevisionContentDto,
	RevisionDto,
	UpdatePageRequest
} from '@infixer-link/contracts';
import { LIMITS } from '@infixer-link/contracts';
import { extractReferences, nameKey, parse, plainLines } from '@infixer-link/content';
import { parseDailyDate } from '@infixer-link/time';
import { ApiError, toIso } from '../http';
import { base64url, sha256Hex } from '../crypto';
import { mediaUrl } from '../assets';

type Operation = 'create' | 'update' | 'delete' | 'restore';

interface PageRow {
	id: string;
	title: string;
	source: string;
	format: 'link-text-v1';
	revision: number;
	daily_date: string | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
}

interface PreparedContent {
	title: string;
	titleKey: string;
	source: string;
	linksJson: string;
	assetsJson: string;
	thumbsJson: string;
}

/** The list reads only the start of each page for card text. */
const LIST_HEAD_CHARS = 600;
const LIST_EXCERPT_CHARS = 120;

const PAGE_COLUMNS =
	'id, title, source, format, revision, daily_date, created_at, updated_at, deleted_at';

function prepareContent(title: string, source: string): PreparedContent {
	const normalizedTitle = title.normalize('NFC').trim();
	const titleKey = nameKey(title);
	if (!titleKey) throw new ApiError('validation_failed', 'title must not be empty');
	if (new TextEncoder().encode(source).length > LIMITS.sourceBytes) {
		throw new ApiError('payload_too_large', `source exceeds ${LIMITS.sourceBytes} bytes`);
	}
	const refs = extractReferences(source);
	if (refs.links.length > LIMITS.linksPerPage) {
		throw new ApiError('payload_too_large', `more than ${LIMITS.linksPerPage} links`);
	}
	if (refs.assets.length > LIMITS.assetsPerPage) {
		throw new ApiError('payload_too_large', `more than ${LIMITS.assetsPerPage} assets`);
	}
	return {
		title: normalizedTitle,
		titleKey,
		source,
		linksJson: JSON.stringify(refs.links),
		assetsJson: JSON.stringify(refs.assets),
		thumbsJson: JSON.stringify(refs.thumbnails)
	};
}

/** Server-computed fingerprint of an operation's intent, used for replay detection. */
function requestHash(parts: unknown[]): Promise<string> {
	return sha256Hex(JSON.stringify(parts));
}

async function findMutation(
	db: D1Database,
	mutationId: string
): Promise<(MutationResult & { requestHash: string }) | null> {
	const row = await db
		.prepare(
			`SELECT r.page_id, r.revision, r.request_hash, r.created_at, c.seq
			 FROM page_revisions r JOIN changes c ON c.page_id = r.page_id AND c.revision = r.revision
			 WHERE r.mutation_id = ?`
		)
		.bind(mutationId)
		.first<{
			page_id: string;
			revision: number;
			request_hash: string;
			created_at: number;
			seq: number;
		}>();
	if (!row) return null;
	return {
		pageId: row.page_id,
		revision: row.revision,
		updatedAt: toIso(row.created_at),
		changeSeq: row.seq,
		mutationId,
		replayed: false,
		requestHash: row.request_hash
	};
}

function withoutHash(found: MutationResult & { requestHash: string }): MutationResult {
	const { pageId, revision, updatedAt, changeSeq, mutationId, replayed } = found;
	return { pageId, revision, updatedAt, changeSeq, mutationId, replayed };
}

/** Returns the stored result for an already-applied mutation, or rejects reuse with other content. */
async function replay(
	db: D1Database,
	mutationId: string,
	hash: string
): Promise<MutationResult | null> {
	const found = await findMutation(db, mutationId);
	if (!found) return null;
	if (found.requestHash !== hash) {
		throw new ApiError('mutation_conflict', 'mutationId was already used for a different request');
	}
	return { ...withoutHash(found), replayed: true };
}

async function committed(db: D1Database, mutationId: string): Promise<MutationResult> {
	const found = await findMutation(db, mutationId);
	if (!found) throw new ApiError('internal_error', 'Committed mutation not found');
	return withoutHash(found);
}

function constraintError(error: unknown): 'name_conflict' | 'daily_conflict' | 'mutation' | null {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('name_conflict') || message.includes('page_names.name_key')) {
		return 'name_conflict';
	}
	if (message.includes('pages.daily_date')) return 'daily_conflict';
	if (message.includes('page_revisions.mutation_id')) return 'mutation';
	return null;
}

/**
 * Runs a write and maps constraint failures. A concurrent duplicate of the same
 * mutation (UNIQUE on mutation_id) resolves to the replay of the winner.
 */
async function write(
	db: D1Database,
	mutationId: string,
	hash: string,
	run: () => Promise<boolean>,
	onMiss: () => Promise<never>
): Promise<MutationResult> {
	let applied: boolean;
	try {
		applied = await run();
	} catch (error) {
		const kind = constraintError(error);
		if (kind === 'name_conflict')
			throw new ApiError('name_conflict', 'A page with this name already exists');
		if (kind === 'daily_conflict')
			throw new ApiError('daily_conflict', 'A daily page for this date already exists');
		if (kind === 'mutation') {
			const result = await replay(db, mutationId, hash);
			if (result) return result;
		}
		throw error;
	}
	if (!applied) {
		const result = await replay(db, mutationId, hash);
		if (result) return result;
		return onMiss();
	}
	return committed(db, mutationId);
}

/** Explains why a conditional UPDATE matched no row. */
async function explainMiss(db: D1Database, id: string, allowDeleted = false): Promise<never> {
	const row = await db
		.prepare('SELECT revision, deleted_at FROM pages WHERE id = ?')
		.bind(id)
		.first<{ revision: number; deleted_at: number | null }>();
	if (!row) throw new ApiError('not_found', 'Page not found');
	if (row.deleted_at !== null && !allowDeleted) {
		throw new ApiError('page_deleted', 'Page is deleted', { currentRevision: row.revision });
	}
	throw new ApiError('revision_conflict', 'Page was changed by another request', {
		currentRevision: row.revision,
		latest: `/api/owner/v1/pages/${id}`
	});
}

export async function createPage(
	db: D1Database,
	input: CreatePageRequest,
	now: number
): Promise<MutationResult> {
	const id = input.id ?? crypto.randomUUID();
	if (input.dailyDate !== undefined && !parseDailyDate(input.dailyDate)) {
		throw new ApiError('validation_failed', 'dailyDate is not a valid date');
	}
	const content = prepareContent(input.title, input.source);
	const hash = await requestHash([
		'create',
		id,
		null,
		content.title,
		input.format,
		content.source,
		input.dailyDate ?? null
	]);

	const replayed = await replay(db, input.mutationId, hash);
	if (replayed) return replayed;

	try {
		return await insertPage(db, id, input, content, hash, now);
	} catch (error) {
		// Tell a client that created the day's page offline which page already exists.
		if (error instanceof ApiError && error.code === 'daily_conflict' && input.dailyDate) {
			const existing = await db
				.prepare('SELECT id FROM pages WHERE daily_date = ?')
				.bind(input.dailyDate)
				.first<{ id: string }>();
			if (existing) {
				throw new ApiError('daily_conflict', error.message, { pageId: existing.id });
			}
		}
		throw error;
	}
}

function insertPage(
	db: D1Database,
	id: string,
	input: CreatePageRequest,
	content: PreparedContent,
	hash: string,
	now: number
): Promise<MutationResult> {
	return write(
		db,
		input.mutationId,
		hash,
		async () => {
			const row = await db
				.prepare(
					`INSERT INTO pages (id, title, title_key, source, format, revision, daily_date, created_at,
					   updated_at, last_mutation_id, request_hash, last_operation, links_json, assets_json,
					   thumbs_json)
					 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'create', ?, ?, ?)
					 ON CONFLICT (id) DO NOTHING
					 RETURNING revision`
				)
				.bind(
					id,
					content.title,
					content.titleKey,
					content.source,
					input.format,
					input.dailyDate ?? null,
					now,
					now,
					input.mutationId,
					hash,
					content.linksJson,
					content.assetsJson,
					content.thumbsJson
				)
				.first();
			return row !== null;
		},
		async () => {
			throw new ApiError('mutation_conflict', 'A page with this id already exists');
		}
	);
}

export async function updatePage(
	db: D1Database,
	id: string,
	input: UpdatePageRequest,
	now: number
): Promise<MutationResult> {
	const content = prepareContent(input.title, input.source);
	const hash = await requestHash([
		'update',
		id,
		input.baseRevision,
		content.title,
		input.format,
		content.source
	]);
	const replayed = await replay(db, input.mutationId, hash);
	if (replayed) return replayed;

	return write(
		db,
		input.mutationId,
		hash,
		async () =>
			(await db
				.prepare(
					`UPDATE pages SET title = ?, title_key = ?, source = ?, format = ?, revision = revision + 1,
					   updated_at = ?, last_mutation_id = ?, request_hash = ?, last_operation = 'update',
					   links_json = ?, assets_json = ?, thumbs_json = ?
					 WHERE id = ? AND revision = ? AND deleted_at IS NULL
					 RETURNING revision`
				)
				.bind(
					content.title,
					content.titleKey,
					content.source,
					input.format,
					now,
					input.mutationId,
					hash,
					content.linksJson,
					content.assetsJson,
					content.thumbsJson,
					id,
					input.baseRevision
				)
				.first()) !== null,
		() => explainMiss(db, id)
	);
}

export async function deletePage(
	db: D1Database,
	id: string,
	input: DeletePageRequest,
	now: number
): Promise<MutationResult> {
	const hash = await requestHash(['delete', id, input.baseRevision]);
	const replayed = await replay(db, input.mutationId, hash);
	if (replayed) return replayed;

	return write(
		db,
		input.mutationId,
		hash,
		async () =>
			(await db
				.prepare(
					`UPDATE pages SET deleted_at = ?, revision = revision + 1, updated_at = ?,
					   last_mutation_id = ?, request_hash = ?, last_operation = 'delete'
					 WHERE id = ? AND revision = ? AND deleted_at IS NULL
					 RETURNING revision`
				)
				.bind(now, now, input.mutationId, hash, id, input.baseRevision)
				.first()) !== null,
		() => explainMiss(db, id)
	);
}

/**
 * Restores the content of a past revision as a new revision. Works on deleted
 * and live pages; unlike edits it does not require `deleted_at IS NULL`.
 */
export async function restorePage(
	db: D1Database,
	id: string,
	input: RestorePageRequest,
	now: number
): Promise<MutationResult> {
	const snapshot = await db
		.prepare(
			input.fromRevision === undefined
				? `SELECT revision, title, format, source FROM page_revisions
				   WHERE page_id = ? AND deleted_at IS NULL ORDER BY revision DESC LIMIT 1`
				: `SELECT revision, title, format, source FROM page_revisions
				   WHERE page_id = ? AND revision = ? AND deleted_at IS NULL`
		)
		.bind(...(input.fromRevision === undefined ? [id] : [id, input.fromRevision]))
		.first<{ revision: number; title: string; format: 'link-text-v1'; source: string }>();
	if (!snapshot) throw new ApiError('not_found', 'Revision to restore not found');

	const content = prepareContent(snapshot.title, snapshot.source);
	const hash = await requestHash(['restore', id, input.baseRevision, snapshot.revision]);
	const replayed = await replay(db, input.mutationId, hash);
	if (replayed) return replayed;

	return write(
		db,
		input.mutationId,
		hash,
		async () =>
			(await db
				.prepare(
					`UPDATE pages SET title = ?, title_key = ?, source = ?, format = ?, deleted_at = NULL,
					   revision = revision + 1, updated_at = ?, last_mutation_id = ?, request_hash = ?,
					   last_operation = 'restore', links_json = ?, assets_json = ?, thumbs_json = ?
					 WHERE id = ? AND revision = ?
					 RETURNING revision`
				)
				.bind(
					content.title,
					content.titleKey,
					content.source,
					snapshot.format,
					now,
					input.mutationId,
					hash,
					content.linksJson,
					content.assetsJson,
					content.thumbsJson,
					id,
					input.baseRevision
				)
				.first()) !== null,
		() => explainMiss(db, id, true)
	);
}

function toPageDto(row: PageRow): PageDto {
	return {
		id: row.id,
		title: row.title,
		format: row.format,
		source: row.source,
		revision: row.revision,
		dailyDate: row.daily_date,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at)
	};
}

/** Public read: deleted pages are not returned. */
export async function getPublicPage(db: D1Database, id: string): Promise<PageDto | null> {
	const row = await db
		.prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ? AND deleted_at IS NULL`)
		.bind(id)
		.first<PageRow>();
	return row ? toPageDto(row) : null;
}

/** Owner read: includes deleted pages so they can be restored. */
export async function getOwnerPage(db: D1Database, id: string): Promise<OwnerPageDto | null> {
	const row = await db
		.prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`)
		.bind(id)
		.first<PageRow>();
	return row ? { ...toPageDto(row), deletedAt: toIso(row.deleted_at) } : null;
}

/** Tells a public reader whether an id belonged to a page that is now deleted. */
export async function isDeletedPage(db: D1Database, id: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS deleted FROM pages WHERE id = ? AND deleted_at IS NOT NULL')
		.bind(id)
		.first();
	return row !== null;
}

function encodeCursor(updatedAt: number, id: string): string {
	return base64url(new TextEncoder().encode(`${updatedAt}:${id}`));
}

function decodeCursor(cursor: string): { updatedAt: number; id: string } {
	try {
		const text = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
		const [ts, id] = [text.slice(0, text.indexOf(':')), text.slice(text.indexOf(':') + 1)];
		const updatedAt = Number(ts);
		if (!Number.isSafeInteger(updatedAt) || !id) throw new Error('bad cursor');
		return { updatedAt, id };
	} catch {
		throw new ApiError('bad_request', 'Invalid cursor');
	}
}

/**
 * Update-ordered list for the card grid. One query: the page window (cursor), then each
 * page's first thumbnail candidate with a ready image (asset, or a card's copied image).
 */
export async function listPages(
	db: D1Database,
	options: { cursor?: string; limit?: number; mediaBaseUrl?: string } = {}
): Promise<PageListDto> {
	const limit = Math.min(Math.max(options.limit ?? LIMITS.listDefault, 1), LIMITS.listMax);
	const after = options.cursor ? decodeCursor(options.cursor) : null;
	const { results } = await db
		.prepare(
			`WITH list AS (
			   SELECT id, title, revision, daily_date, updated_at, thumbs_json,
			     substr(source, 1, ${LIST_HEAD_CHARS}) AS head
			   FROM pages
			   WHERE deleted_at IS NULL ${after ? 'AND (updated_at < ?1 OR (updated_at = ?1 AND id < ?2))' : ''}
			   ORDER BY updated_at DESC, id DESC LIMIT ${after ? '?3' : '?1'}
			 ),
			 candidates AS (
			   SELECT l.id AS page_id, CAST(j.key AS INTEGER) AS ord, j.value AS ref
			   FROM list l, json_each(l.thumbs_json) j
			 ),
			 images AS (
			   SELECT c.page_id, c.ord, a.object_key, a.width, a.height
			   FROM candidates c JOIN assets a ON a.id = substr(c.ref, 7) AND a.status = 'ready'
			   WHERE substr(c.ref, 1, 6) = 'asset:'
			   UNION ALL
			   SELECT c.page_id, c.ord, a.object_key, a.width, a.height
			   FROM candidates c JOIN link_previews lp ON lp.url = substr(c.ref, 5)
			   JOIN assets a ON a.id = lp.image_asset_id AND a.status = 'ready'
			   WHERE substr(c.ref, 1, 4) = 'url:'
			 ),
			 first_image AS (
			   SELECT page_id, min(ord) AS ord, object_key, width, height FROM images GROUP BY page_id
			 )
			 SELECT l.id, l.title, l.revision, l.daily_date, l.updated_at, l.head,
			   f.object_key AS thumb_key, f.width AS thumb_width, f.height AS thumb_height
			 FROM list l LEFT JOIN first_image f ON f.page_id = l.id
			 ORDER BY l.updated_at DESC, l.id DESC`
		)
		.bind(...(after ? [after.updatedAt, after.id, limit + 1] : [limit + 1]))
		.all<{
			id: string;
			title: string;
			revision: number;
			daily_date: string | null;
			updated_at: number;
			head: string;
			thumb_key: string | null;
			thumb_width: number | null;
			thumb_height: number | null;
		}>();

	const base = options.mediaBaseUrl ?? '/media';
	const page = results.slice(0, limit);
	const last = page.at(-1);
	return {
		pages: page.map((r) => ({
			id: r.id,
			title: r.title,
			revision: r.revision,
			dailyDate: r.daily_date,
			updatedAt: toIso(r.updated_at),
			thumbnail:
				r.thumb_key && r.thumb_width && r.thumb_height
					? { url: mediaUrl(base, r.thumb_key), width: r.thumb_width, height: r.thumb_height }
					: null,
			excerpt: plainLines(parse(r.head), LIST_EXCERPT_CHARS)
		})),
		nextCursor: results.length > limit && last ? encodeCursor(last.updated_at, last.id) : null
	};
}

/** Resolves a title or alias to a live page. */
export async function resolveName(db: D1Database, title: string): Promise<ResolveDto | null> {
	const row = await db
		.prepare(
			`SELECT n.page_id, n.kind, p.title FROM page_names n JOIN pages p ON p.id = n.page_id
			 WHERE n.name_key = ? AND p.deleted_at IS NULL`
		)
		.bind(nameKey(title))
		.first<{ page_id: string; kind: 'canonical' | 'alias'; title: string }>();
	return row ? { pageId: row.page_id, title: row.title, matchedAlias: row.kind === 'alias' } : null;
}

export async function listRevisions(db: D1Database, id: string): Promise<RevisionDto[] | null> {
	const { results } = await db
		.prepare(
			`SELECT revision, operation, title, deleted_at, created_at FROM page_revisions
			 WHERE page_id = ? ORDER BY revision DESC LIMIT 500`
		)
		.bind(id)
		.all<{
			revision: number;
			operation: Operation;
			title: string;
			deleted_at: number | null;
			created_at: number;
		}>();
	if (results.length === 0) return null;
	return results.map((r) => ({
		revision: r.revision,
		operation: r.operation,
		title: r.title,
		deleted: r.deleted_at !== null,
		createdAt: toIso(r.created_at)
	}));
}

/** Content of one revision (owner): the common base for a three-way comparison. */
export async function getRevision(
	db: D1Database,
	id: string,
	revision: number
): Promise<RevisionContentDto | null> {
	const row = await db
		.prepare(
			`SELECT revision, title, source, deleted_at FROM page_revisions
			 WHERE page_id = ? AND revision = ?`
		)
		.bind(id, revision)
		.first<{ revision: number; title: string; source: string; deleted_at: number | null }>();
	return row
		? {
				revision: row.revision,
				title: row.title,
				source: row.source,
				deleted: row.deleted_at !== null
			}
		: null;
}

/**
 * Returns the daily page for `date`, creating an empty one if needed (design §8
 * `POST /daily/{date}`). Concurrent calls never create two pages: the UNIQUE
 * daily_date constraint decides and the loser reads the winner.
 */
export async function getOrCreateDaily(
	db: D1Database,
	date: string,
	mutationId: string,
	now: number
): Promise<DailyPageDto> {
	if (!parseDailyDate(date)) throw new ApiError('not_found', 'Invalid date');

	const existing = () =>
		db
			.prepare('SELECT id, title, revision FROM pages WHERE daily_date = ? AND deleted_at IS NULL')
			.bind(date)
			.first<{ id: string; title: string; revision: number }>();

	const found = await existing();
	if (found) {
		return {
			pageId: found.id,
			title: found.title,
			revision: found.revision,
			dailyDate: date,
			created: false
		};
	}
	const deleted = await db
		.prepare('SELECT id FROM pages WHERE daily_date = ? AND deleted_at IS NOT NULL')
		.bind(date)
		.first<{ id: string }>();
	if (deleted) {
		throw new ApiError('page_deleted', 'The daily page for this date was deleted', {
			pageId: deleted.id
		});
	}

	try {
		const result = await createPage(
			db,
			{ mutationId, title: date, format: 'link-text-v1', source: '', dailyDate: date },
			now
		);
		return {
			pageId: result.pageId,
			title: date,
			revision: result.revision,
			dailyDate: date,
			created: !result.replayed
		};
	} catch (error) {
		if (error instanceof ApiError && error.code === 'daily_conflict') {
			const winner = await existing();
			if (winner) {
				return {
					pageId: winner.id,
					title: winner.title,
					revision: winner.revision,
					dailyDate: date,
					created: false
				};
			}
		}
		throw error;
	}
}

/** Public lookup used by /daily/{date}: live page id for a date, if any. */
export async function findDaily(
	db: D1Database,
	date: string
): Promise<{ id: string; title: string } | null> {
	return db
		.prepare('SELECT id, title FROM pages WHERE daily_date = ? AND deleted_at IS NULL')
		.bind(date)
		.first<{ id: string; title: string }>();
}
