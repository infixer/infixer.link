/**
 * Fills `pages.thumbs_json` (migration 0006, ADR 0014) for pages saved before it,
 * in the LOCAL D1. New saves compute it themselves; this does not create revisions.
 *
 *   node scripts/backfill-thumbnails.ts [--persist-to dir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { extractReferences } from '../../../packages/content/src/index.ts';

const { values } = parseArgs({ options: { 'persist-to': { type: 'string' } } });
const local = ['--local', ...(values['persist-to'] ? ['--persist-to', values['persist-to']] : [])];

const out = execFileSync(
	'pnpm',
	[
		'exec',
		'wrangler',
		'd1',
		'execute',
		'DB',
		...local,
		'--json',
		'--command',
		"SELECT id, source FROM pages WHERE thumbs_json = '[]'"
	],
	{ encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 }
);
const rows = (JSON.parse(out) as { results: { id: string; source: string }[] }[])[0]!.results;

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const updates = rows
	.map((r) => ({ id: r.id, thumbs: extractReferences(r.source).thumbnails }))
	.filter((r) => r.thumbs.length > 0)
	.map(
		(r) => `UPDATE pages SET thumbs_json = ${q(JSON.stringify(r.thumbs))} WHERE id = ${q(r.id)}`
	);

if (updates.length > 0) {
	mkdirSync('.wrangler', { recursive: true });
	writeFileSync('.wrangler/backfill-thumbnails.sql', updates.join(';\n') + ';\n');
	execFileSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'DB',
			...local,
			'--yes',
			'--file',
			'.wrangler/backfill-thumbnails.sql'
		],
		{ stdio: 'inherit' }
	);
}
console.log(`Checked ${rows.length} pages; set thumbnails for ${updates.length}.`);
