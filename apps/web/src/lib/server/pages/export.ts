/**
 * Bulk export for the CLI (design §13.2, §15, ADR 0016).
 *
 * An export is pinned to the change-feed position at its start (`highWater`): each page
 * is returned as its latest revision at or before that position, so edits made while a
 * long export pages through the data cannot mix old and new pages. Pages deleted at that
 * point are left out. Paging is by page id, a bounded number of pages per request — the
 * Worker never builds an archive in one request.
 */
import type {
	ExportAssetsDto,
	ExportPageDto,
	ExportPagesDto,
	ExportStartDto
} from '@infixer-link/contracts';
import { toIso } from '../http';
import { mediaUrl } from '../assets';

const MAX_PAGES = 100;
const MAX_ASSETS = 500;

export async function startExport(db: D1Database): Promise<ExportStartDto> {
	const [seq, pages, assets] = await db.batch<{ n: number | null }>([
		db.prepare('SELECT max(seq) AS n FROM changes'),
		db.prepare('SELECT count(*) AS n FROM pages WHERE deleted_at IS NULL'),
		db.prepare("SELECT count(*) AS n FROM assets WHERE status = 'ready'")
	]);
	return {
		highWater: seq.results[0]?.n ?? 0,
		pages: pages.results[0]?.n ?? 0,
		assets: assets.results[0]?.n ?? 0
	};
}

export async function exportPages(
	db: D1Database,
	options: { until: number; cursor?: string; limit?: number }
): Promise<ExportPagesDto> {
	const limit = Math.min(Math.max(options.limit ?? MAX_PAGES, 1), MAX_PAGES);
	const { results } = await db
		.prepare(
			`WITH latest AS (
			   SELECT page_id, max(revision) AS revision FROM changes
			   WHERE seq <= ?1 AND page_id > ?2
			   GROUP BY page_id ORDER BY page_id LIMIT ?3
			 )
			 SELECT r.page_id, r.revision, r.title, r.format, r.source, r.deleted_at,
			   r.created_at AS updated_at, p.daily_date, p.created_at,
			   (SELECT json_group_array(n.display_name) FROM page_names n
			    WHERE n.page_id = r.page_id AND n.kind = 'alias') AS aliases
			 FROM latest l
			 JOIN page_revisions r ON r.page_id = l.page_id AND r.revision = l.revision
			 JOIN pages p ON p.id = r.page_id
			 ORDER BY r.page_id`
		)
		.bind(options.until, options.cursor ?? '', limit)
		.all<{
			page_id: string;
			revision: number;
			title: string;
			format: 'link-text-v1';
			source: string;
			deleted_at: number | null;
			updated_at: number;
			daily_date: string | null;
			created_at: number;
			aliases: string;
		}>();
	const pages: ExportPageDto[] = results
		.filter((r) => r.deleted_at === null)
		.map((r) => ({
			id: r.page_id,
			title: r.title,
			format: r.format,
			revision: r.revision,
			source: r.source,
			dailyDate: r.daily_date,
			createdAt: toIso(r.created_at),
			updatedAt: toIso(r.updated_at),
			aliases: JSON.parse(r.aliases) as string[]
		}));
	return {
		pages,
		nextCursor: results.length === limit ? results.at(-1)!.page_id : null
	};
}

export async function exportAssets(
	db: D1Database,
	options: { cursor?: string; limit?: number; mediaBaseUrl: string }
): Promise<ExportAssetsDto> {
	const limit = Math.min(Math.max(options.limit ?? MAX_ASSETS, 1), MAX_ASSETS);
	const { results } = await db
		.prepare(
			`SELECT id, mime, bytes, width, height, sha256, object_key, source FROM assets
			 WHERE status = 'ready' AND id > ? ORDER BY id LIMIT ?`
		)
		.bind(options.cursor ?? '', limit)
		.all<{
			id: string;
			mime: string;
			bytes: number;
			width: number;
			height: number;
			sha256: string;
			object_key: string;
			source: 'upload' | 'link-preview';
		}>();
	return {
		assets: results.map((r) => ({
			id: r.id,
			mime: r.mime,
			bytes: r.bytes,
			width: r.width,
			height: r.height,
			sha256: r.sha256,
			url: mediaUrl(options.mediaBaseUrl, r.object_key),
			source: r.source
		})),
		nextCursor: results.length === limit ? results.at(-1)!.id : null
	};
}
