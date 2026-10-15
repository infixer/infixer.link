/**
 * infixer — command line client for infixer.link (design §13.1, ADR 0016).
 * Requires Node.js 22.18+ (runs this TypeScript directly).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Api } from './api.ts';
import { loadConfig, removeConfig, saveConfig } from './config.ts';
import { CliError, EXIT } from './errors.ts';
import { exportAll, importAll } from './export.ts';
import { nodeStore } from './node-files.ts';
import { append, create, getPage, resolveTarget, search, update } from './pages.ts';

const HELP = `infixer — infixer.link のコマンドラインクライアント

使い方:
  infixer get <id|タイトル|today>             ページの本文を表示
  infixer search <語...> [--limit n]           検索
  infixer today [--create]                     今日の日記を表示（--create で作成）
  infixer append <id|タイトル|today> [文...]   末尾に追記（文がなければ標準入力。today は無ければ作成）
  infixer put <id|タイトル> --file <path|-> --base-revision <n> [--title t]
  infixer create <タイトル> [--file <path|->]  ページを作成
  infixer export <dir> [--with-assets]         本文（と画像）を持ち出す（backup スコープ）
  infixer backup <dir> [--no-assets]           <dir>/infixer-backup-<日時>/ に画像込みで持ち出す
  infixer import <dir>                         export を空のサイトに復元（write スコープ）
  infixer auth login [--url URL]               トークンを標準入力から読んで保存
  infixer auth status | logout

共通: --json（結果を JSON で出力）, --url URL
環境変数: INFIXER_URL, INFIXER_TOKEN（設定ファイルより優先）
終了コード: 0 成功, 1 エラー, 2 使い方, 3 見つからない, 4 競合, 5 認証, 6 通信`;

const OPTIONS = {
	json: { type: 'boolean' },
	url: { type: 'string' },
	file: { type: 'string' },
	title: { type: 'string' },
	'base-revision': { type: 'string' },
	limit: { type: 'string' },
	create: { type: 'boolean' },
	'with-assets': { type: 'boolean' },
	'no-assets': { type: 'boolean' },
	help: { type: 'boolean', short: 'h' }
} as const;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

async function readInput(file: string | undefined): Promise<string> {
	if (!file || file === '-') return readStdin();
	return readFile(file, 'utf8');
}

function out(json: boolean, value: unknown, text: string) {
	process.stdout.write(
		json ? `${JSON.stringify(value, null, 2)}\n` : text.endsWith('\n') ? text : `${text}\n`
	);
}

const progress = (json: boolean) => (message: string) => {
	if (!json && process.stderr.isTTY) process.stderr.write(`\r${message}   `);
};

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: OPTIONS,
		allowPositionals: true
	});
	const [command, ...rest] = positionals;
	const json = values.json ?? false;
	if (!command || values.help) {
		process.stdout.write(`${HELP}\n`);
		return command || values.help ? EXIT.ok : EXIT.usage;
	}
	const config = await loadConfig();
	const url = values.url ?? config.url;
	const api = new Api({ baseUrl: url, token: config.token });
	const need = (n: number, usage: string) => {
		if (rest.length < n) throw new CliError(`使い方: infixer ${usage}`, EXIT.usage);
	};

	switch (command) {
		case 'get': {
			need(1, 'get <id|タイトル|today>');
			const page = await getPage(api, await resolveTarget(api, rest.join(' ')));
			if (json) out(json, page, '');
			// Exactly the stored body when piped (get → edit → put round-trips byte for byte).
			else process.stdout.write(process.stdout.isTTY ? `${page.source}\n` : page.source);
			return EXIT.ok;
		}
		case 'search': {
			need(1, 'search <語...>');
			const result = await search(
				api,
				rest.join(' '),
				values.limit ? Number(values.limit) : undefined
			);
			out(
				json,
				result,
				result.hits.length
					? result.hits
							.map((h) => `${h.title}\t${h.id}\n  ${h.excerpt.map((p) => p.text).join('')}`)
							.join('\n')
					: '見つかりませんでした'
			);
			return result.hits.length ? EXIT.ok : EXIT.notFound;
		}
		case 'today': {
			const id = await resolveTarget(api, 'today', {
				createToday: values.create
			});
			const page = await getPage(api, id);
			out(json, page, `# ${page.title}（${page.id}）\n${page.source}`);
			return EXIT.ok;
		}
		case 'append': {
			need(1, 'append <id|タイトル|today> [文...]');
			const [target, ...words] = rest;
			const text = words.length ? words.join(' ') : await readInput(values.file);
			if (!text.trim()) throw new CliError('追記する内容がありません', EXIT.usage);
			const id = await resolveTarget(api, target!, { createToday: true });
			const result = await append(api, id, text);
			out(json, result, `追記しました（版 ${result.revision}）`);
			return EXIT.ok;
		}
		case 'put': {
			need(1, 'put <id|タイトル> --file <path|-> --base-revision <n>');
			const base = Number(values['base-revision']);
			if (!values.file || !Number.isSafeInteger(base) || base < 1) {
				throw new CliError('--file と --base-revision（1 以上の整数）が必要です', EXIT.usage);
			}
			const id = await resolveTarget(api, rest.join(' '));
			const title = values.title ?? (await getPage(api, id)).title;
			const result = await update(api, id, {
				baseRevision: base,
				title,
				source: await readInput(values.file),
				mutationId: crypto.randomUUID()
			});
			out(json, result, `更新しました（版 ${result.revision}）`);
			return EXIT.ok;
		}
		case 'create': {
			need(1, 'create <タイトル> [--file <path|->]');
			const source = values.file ? await readInput(values.file) : '';
			const result = await create(api, {
				title: rest.join(' '),
				source,
				mutationId: crypto.randomUUID()
			});
			out(json, result, `作成しました: ${result.pageId}`);
			return EXIT.ok;
		}
		case 'export':
		case 'backup': {
			need(1, `${command} <dir>`);
			let dir = rest[0]!;
			if (command === 'backup') {
				const stamp = new Date()
					.toISOString()
					.replace(/[-:]/g, '')
					.replace(/\..+$/, '')
					.replace('T', '-');
				dir = path.join(dir, `infixer-backup-${stamp}`);
			}
			const withAssets =
				command === 'backup' ? !values['no-assets'] : (values['with-assets'] ?? false);
			const manifest = await exportAll(api, nodeStore(dir), {
				withAssets,
				progress: progress(json)
			});
			if (!json && process.stderr.isTTY) process.stderr.write('\n');
			out(
				json,
				{ dir, ...manifest, files: Object.keys(manifest.files).length },
				`${dir} に書き出しました：ページ ${manifest.pages} 件、画像 ${manifest.assets.downloaded} / ${manifest.assets.listed} 件`
			);
			return EXIT.ok;
		}
		case 'import': {
			need(1, 'import <dir>');
			const report = await importAll(api, nodeStore(rest[0]!), {
				progress: progress(json)
			});
			if (!json && process.stderr.isTTY) process.stderr.write('\n');
			out(
				json,
				report,
				[
					`作成 ${report.created} 件、同じ内容 ${report.unchanged} 件、画像 ${report.images.uploaded} 件`,
					...report.conflicts.map((c) => `復元できませんでした: ${c.title}（${c.id}）: ${c.reason}`)
				].join('\n')
			);
			return report.conflicts.length ? EXIT.conflict : EXIT.ok;
		}
		case 'auth': {
			const [sub] = rest;
			if (sub === 'login') {
				if (process.stdin.isTTY)
					process.stderr.write('トークンを貼り付けて Enter、続けて Ctrl-D:\n');
				const token = (await readStdin()).trim();
				if (!/^ifx_[A-Za-z0-9_-]{20,}$/.test(token))
					throw new CliError('トークンの形式が違います', EXIT.usage);
				const file = await saveConfig({
					url: new Api({ baseUrl: url }).origin,
					token
				});
				out(json, { saved: file }, `保存しました: ${file}`);
				return EXIT.ok;
			}
			if (sub === 'logout') {
				await removeConfig();
				out(json, { removed: true }, 'トークンを削除しました（サイト側でも失効させてください）');
				return EXIT.ok;
			}
			if (sub === 'status') {
				await api.request('GET', '/api/owner/v1/titles?limit=1');
				out(json, { url: api.origin, ok: true }, `${api.origin} に接続できます（read スコープ）`);
				return EXIT.ok;
			}
			throw new CliError('使い方: infixer auth login|status|logout', EXIT.usage);
		}
		default:
			throw new CliError(`不明なコマンドです: ${command}（infixer --help）`, EXIT.usage);
	}
}
