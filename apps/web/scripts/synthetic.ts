/**
 * Deterministic synthetic pages for performance measurement (design §17 Phase 5).
 * Shared by `tests/perf` (workerd) and `scripts/seed-synthetic.ts` (local D1).
 *
 * Shape (roughly a Cosense project): daily pages and topic pages, Japanese prose
 * mixed with katakana and Latin words, 2–6 links per page, a hub tag (#読書) on
 * about 30% of pages, a few long pages, and marker words with known frequencies.
 */

/** Words with known frequency, used by the benchmark queries. */
export const MARKERS = {
	/** Exactly one page. */
	unique: '目印語ユニーク',
	/** About 0.5% of pages. */
	rare: 'アンチ・オイディプス',
	/** About 10% of pages. */
	latin: 'Cloudflare',
	/** Hub tag on about 30% of pages. */
	hub: '読書'
} as const;

export interface SyntheticPage {
	id: string;
	title: string;
	source: string;
	dailyDate: string | null;
	updatedAt: number;
}

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KANJI =
	'日本語文章読書記録思考哲学欲望機械社会言語時間空間存在意味身体世界歴史政治経済芸術音楽映画写真料理旅行仕事生活健康研究設計実装検索速度表示編集保存画像関係問題解決方法理論実践経験自由情報技術'.split(
		''
	);
const KANA =
	'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン'.split(
		''
	);
const PARTICLES = ['の', 'は', 'を', 'に', 'で', 'と', 'が', 'から', 'まで', 'について'];
const ENDINGS = ['。', 'た。', 'だ。', 'と思う。', 'かもしれない。', 'を読んだ。', 'を考えた。'];
const LATIN = ['SvelteKit', 'Workers', 'D1', 'R2', 'TypeScript', 'Temporal', 'Hono', 'SQLite'];

/** UUID-shaped id derived from the index (stable across runs, valid for the API's UUID check). */
export function syntheticId(i: number): string {
	const hex = (i + 1).toString(16).padStart(12, '0');
	return `5e000000-0000-4000-8000-${hex}`;
}

export function generatePages(count: number, now = Date.UTC(2026, 9, 15)): SyntheticPage[] {
	const rand = mulberry32(20261015 + count);
	const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
	// Zipf-like vocabulary: early words are much more frequent.
	const vocab = Array.from({ length: 600 }, (_, i) =>
		i % 3 === 0
			? Array.from({ length: 3 + (i % 4) }, () => pick(KANA)).join('')
			: Array.from({ length: 2 }, () => pick(KANJI)).join('')
	);
	const word = () => vocab[Math.floor(vocab.length * rand() ** 2.5)]!;

	const titles: string[] = [];
	const dailyCount = Math.floor(count * 0.4);
	const start = Date.UTC(2020, 0, 1);
	for (let i = 0; i < count; i++) {
		titles.push(
			i < dailyCount
				? new Date(start + i * 86_400_000).toISOString().slice(0, 10)
				: `${word()}${word()} ${i}`
		);
	}

	const sentence = () => {
		let s = '';
		const n = 2 + Math.floor(rand() * 5);
		for (let k = 0; k < n; k++) s += word() + (k < n - 1 ? pick(PARTICLES) : '');
		if (rand() < 0.15) s += ` ${pick(LATIN)} `;
		return s + pick(ENDINGS);
	};

	const pages: SyntheticPage[] = [];
	for (let i = 0; i < count; i++) {
		const lines: string[] = [];
		// Most pages are short notes; ~3% are long (10k+ characters).
		const long = rand() < 0.03;
		const lineCount = long ? 300 + Math.floor(rand() * 100) : 5 + Math.floor(rand() * 25);
		for (let l = 0; l < lineCount; l++) {
			const indent = rand() < 0.4 ? ' '.repeat(1 + Math.floor(rand() * 2)) : '';
			lines.push(indent + sentence());
		}
		const links = 2 + Math.floor(rand() * 5);
		for (let k = 0; k < links; k++) {
			const at = Math.floor(rand() * lines.length);
			lines[at] += ` [${titles[Math.floor(rand() * count)]}]`;
		}
		if (rand() < 0.3) lines.push(` #${MARKERS.hub}`);
		if (rand() < 0.005)
			lines.splice(Math.floor(rand() * lines.length), 0, `[${MARKERS.rare}] を再読`);
		if (rand() < 0.1) lines.push(`${MARKERS.latin} の設定を見直した`);
		if (i === Math.floor(count / 2))
			lines.splice(Math.floor(lines.length / 2), 0, `${MARKERS.unique}はここ`);
		pages.push({
			id: syntheticId(i),
			title: titles[i]!,
			source: lines.join('\n'),
			dailyDate: i < dailyCount ? titles[i]! : null,
			updatedAt: now - (count - i) * 60_000
		});
	}
	return pages;
}
