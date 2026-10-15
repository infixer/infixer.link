/**
 * Inserts a few sample pages into the LOCAL D1 for manual checks.
 * Triggers derive history, names, links and search exactly like the API path.
 *
 *   node scripts/seed-local.ts [--persist-to dir]
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { extractReferences, nameKey } from '../../../packages/content/src/index.ts';

const { values } = parseArgs({ options: { 'persist-to': { type: 'string' } } });

const now = Date.now();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date(now));

const samples: { title: string; source: string; daily?: string }[] = [
	{
		title: today,
		daily: today,
		source: `今日読んだもの\n [アンチ・オイディプス] の続きを読んだ\n #読書\n [https://example.org 参考資料]`
	},
	{ title: 'アンチ・オイディプス', source: 'ドゥルーズ＝ガタリの本\n #読書' },
	{ title: '読書', source: '読書メモの入口' }
];

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

const statements = samples.map((p, i) => {
	const refs = extractReferences(p.source);
	const ts = now - (samples.length - i) * 1000;
	return `INSERT INTO pages (id, title, title_key, source, format, revision, daily_date, created_at, updated_at,
	  last_mutation_id, request_hash, last_operation, links_json, assets_json)
	SELECT ${q(crypto.randomUUID())}, ${q(p.title)}, ${q(nameKey(p.title))}, ${q(p.source)}, 'link-text-v1', 1,
	  ${p.daily ? q(p.daily) : 'NULL'}, ${ts}, ${ts}, ${q(crypto.randomUUID())}, 'seed', 'create',
	  ${q(JSON.stringify(refs.links))}, ${q(JSON.stringify(refs.assets))}
	WHERE NOT EXISTS (SELECT 1 FROM page_names WHERE name_key = ${q(nameKey(p.title))})`;
});

const args = ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local'];
if (values['persist-to']) args.push('--persist-to', values['persist-to']);
args.push('--command', statements.join(';\n'));
execFileSync('pnpm', args, { stdio: 'inherit' });
console.log(`Seeded ${samples.length} sample pages (existing names are skipped).`);
