/**
 * `infixer export` / `backup` (design §13.2) and `infixer import` (restore into an
 * empty site; the fixture for Phase 8's restore drill).
 *
 *   manifest.json            schemaVersion, time, site, highWater, counts, sha256 of every file
 *   pages/{id}.link.txt      body as stored (link-text-v1)
 *   metadata/{id}.json       id, title, format, revision, dailyDate, timestamps, aliases
 *   assets-manifest.json     every ready image (downloaded or not)
 *   assets/{id}.{ext}        only with --with-assets, verified against its SHA-256
 */
import type {
	AssetDto,
	ExportAssetDto,
	ExportAssetsDto,
	ExportPageDto,
	ExportPagesDto,
	ExportStartDto,
	OwnerPageDto
} from '@infixer-link/contracts';
import type { Api } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import { sha256Hex, type FileStore } from './files.ts';
import { create, update } from './pages.ts';

export const EXPORT_FORMAT = 'infixer-link-export';
export const SCHEMA_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSIONS: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp'
};

export interface Manifest {
	format: typeof EXPORT_FORMAT;
	schemaVersion: number;
	exportedAt: string;
	site: string;
	highWater: number;
	pages: number;
	assets: { listed: number; downloaded: number };
	/** Relative path → SHA-256 of every file except this one. */
	files: Record<string, string>;
}

export interface AssetEntry extends Omit<ExportAssetDto, 'url'> {
	url: string;
	/** Relative path when downloaded. */
	file: string | null;
}

function checkId(id: string): string {
	if (!UUID_RE.test(id)) throw new CliError(`不正な id です: ${JSON.stringify(id)}`, EXIT.error);
	return id;
}

export async function exportAll(
	api: Api,
	store: FileStore,
	options: {
		withAssets: boolean;
		now?: () => Date;
		progress?: (message: string) => void;
	}
): Promise<Manifest> {
	if (!(await store.isEmpty())) {
		throw new CliError('出力先のディレクトリが空ではありません', EXIT.usage);
	}
	const files: Record<string, string> = {};
	const put = async (relative: string, data: Uint8Array | string) => {
		await store.write(relative, data);
		files[relative] = await sha256Hex(data);
	};

	const start = await api.request<ExportStartDto>('GET', '/api/owner/v1/export/start');
	let pages = 0;
	let cursor = '';
	do {
		const batch: ExportPagesDto = await api.request(
			'GET',
			`/api/owner/v1/export/pages?until=${start.highWater}&cursor=${encodeURIComponent(cursor)}`
		);
		for (const page of batch.pages) {
			const id = checkId(page.id);
			const { source, ...metadata } = page satisfies ExportPageDto;
			await put(`pages/${id}.link.txt`, source);
			await put(`metadata/${id}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
			pages++;
		}
		options.progress?.(`ページ ${pages} / ${start.pages}`);
		cursor = batch.nextCursor ?? '';
	} while (cursor);

	const assets: AssetEntry[] = [];
	cursor = '';
	do {
		const batch: ExportAssetsDto = await api.request(
			'GET',
			`/api/owner/v1/export/assets?cursor=${encodeURIComponent(cursor)}`
		);
		for (const asset of batch.assets) {
			const id = checkId(asset.id);
			let file: string | null = null;
			if (options.withAssets) {
				const ext = EXTENSIONS[asset.mime];
				if (!ext) throw new CliError(`未対応の画像形式です: ${asset.mime}`, EXIT.error);
				const bytes = await api.download(asset.url);
				if ((await sha256Hex(bytes)) !== asset.sha256) {
					throw new CliError(`画像のハッシュが一致しません: ${id}`, EXIT.error);
				}
				file = `assets/${id}.${ext}`;
				await put(file, bytes);
				options.progress?.(`画像 ${assets.length + 1} / ${start.assets}`);
			}
			assets.push({ ...asset, file });
		}
		cursor = batch.nextCursor ?? '';
	} while (cursor);
	await put('assets-manifest.json', `${JSON.stringify({ assets }, null, 2)}\n`);

	const manifest: Manifest = {
		format: EXPORT_FORMAT,
		schemaVersion: SCHEMA_VERSION,
		exportedAt: (options.now?.() ?? new Date()).toISOString(),
		site: api.origin,
		highWater: start.highWater,
		pages,
		assets: {
			listed: assets.length,
			downloaded: assets.filter((a) => a.file).length
		},
		files
	};
	await store.write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

export interface ImportReport {
	created: number;
	/** Already present with the same title and body. */
	unchanged: number;
	conflicts: { id: string; title: string; reason: string }[];
	images: { uploaded: number; missing: number };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Restores an export into a site, keeping page and image ids. Meant for an empty site
 * (Phase 8 restore drill); pages that already exist are compared and never overwritten.
 * Old names are restored as aliases by renaming through them; the revision history and
 * timestamps are not (the export does not contain them).
 */
export async function importAll(
	api: Api,
	store: FileStore,
	options: { newId?: () => string; progress?: (message: string) => void } = {}
): Promise<ImportReport> {
	const newId = options.newId ?? (() => crypto.randomUUID());
	const manifest = JSON.parse(decode(await store.read('manifest.json'))) as Manifest;
	if (manifest.format !== EXPORT_FORMAT || manifest.schemaVersion !== SCHEMA_VERSION) {
		throw new CliError('infixer の export ではないか、対応していない版です', EXIT.usage);
	}
	for (const [relative, hash] of Object.entries(manifest.files)) {
		if ((await sha256Hex(await store.read(relative))) !== hash) {
			throw new CliError(`ファイルが壊れているか変更されています: ${relative}`, EXIT.error);
		}
	}

	const report: ImportReport = {
		created: 0,
		unchanged: 0,
		conflicts: [],
		images: { uploaded: 0, missing: 0 }
	};

	// Images first, so pages never reference an image that is not there.
	const { assets } = JSON.parse(decode(await store.read('assets-manifest.json'))) as {
		assets: AssetEntry[];
	};
	for (const asset of assets) {
		if (!asset.file) {
			report.images.missing++;
			continue;
		}
		const id = checkId(asset.id);
		const bytes = await store.read(asset.file);
		await api.send('PUT', `/api/owner/v1/assets/${id}`, bytes, asset.mime);
		const done = await api.request<AssetDto>('POST', `/api/owner/v1/assets/${id}/complete`, {
			body: {}
		});
		if (done.status !== 'ready') throw new CliError(`画像を復元できませんでした: ${id}`);
		report.images.uploaded++;
	}

	const ids = Object.keys(manifest.files)
		.map((f) => /^metadata\/([0-9a-f-]{36})\.json$/.exec(f)?.[1])
		.filter((id): id is string => !!id);
	for (const id of ids) {
		const meta = JSON.parse(decode(await store.read(`metadata/${checkId(id)}.json`))) as Omit<
			ExportPageDto,
			'source'
		>;
		const source = decode(await store.read(`pages/${id}.link.txt`));
		const names = [...meta.aliases, meta.title];
		try {
			let result = await create(api, {
				id,
				title: names[0]!,
				source,
				mutationId: newId(),
				dailyDate: meta.dailyDate ?? undefined
			});
			for (const name of names.slice(1)) {
				result = await update(api, id, {
					baseRevision: result.revision,
					title: name,
					source,
					mutationId: newId()
				});
			}
			report.created++;
		} catch (error) {
			if (!(error instanceof CliError)) throw error;
			if (error.code === 'mutation_conflict') {
				// The id exists: unchanged when identical, otherwise left alone.
				const existing = await api.request<OwnerPageDto>('GET', `/api/owner/v1/pages/${id}`);
				if (existing.title === meta.title && existing.source === source && !existing.deletedAt) {
					report.unchanged++;
				} else {
					report.conflicts.push({
						id,
						title: meta.title,
						reason: 'サイトの内容と異なります'
					});
				}
			} else if (error.exitCode === EXIT.network || error.exitCode === EXIT.auth) {
				throw error;
			} else {
				report.conflicts.push({ id, title: meta.title, reason: error.message });
			}
		}
		options.progress?.(
			`ページ ${report.created + report.unchanged + report.conflicts.length} / ${ids.length}`
		);
	}
	return report;
}
