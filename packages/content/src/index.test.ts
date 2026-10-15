import { describe, expect, it } from 'vitest';
import { extractReferences, nameKey } from './index.ts';

describe('nameKey', () => {
	it('applies NFC and trims, but keeps case and width', () => {
		expect(nameKey('  \u30ab\u3099  ')).toBe('\u30ac'); // decomposed カ + ゙ -> composed ガ
		expect(nameKey('Cloudflare')).not.toBe(nameKey('cloudflare'));
		expect(nameKey('ＡＢＣ')).toBe('ＡＢＣ'); // no NFKC folding
	});
});

describe('extractReferences', () => {
	it('extracts internal links, tags and assets from the design example', () => {
		const source = [
			'今日読んだもの',
			' [アンチ・オイディプス] の続きを読んだ',
			' #読書',
			' [https://example.org 参考資料]',
			' [asset:550E8400-E29B-41D4-A716-446655440000]'
		].join('\n');
		expect(extractReferences(source)).toEqual({
			links: ['アンチ・オイディプス', '読書'],
			assets: ['550e8400-e29b-41d4-a716-446655440000']
		});
	});

	it('keeps links to pages that do not exist yet and dedupes them', () => {
		expect(extractReferences('[未作成] と [未作成] と #未作成').links).toEqual(['未作成']);
	});

	it('ignores URLs, labelled URLs, decorations and math', () => {
		const source = '[https://a.example] [参考 https://b.example] [* 太字] [/ 斜体] [$ x^2]';
		expect(extractReferences(source)).toEqual({ links: [], assets: [] });
	});

	it('ignores references inside inline code and tags inside URLs', () => {
		const source = '`[コード内]` `#notatag` https://example.org/#fragment';
		expect(extractReferences(source).links).toEqual([]);
	});

	it('does not treat a # in the middle of a word as a tag', () => {
		expect(extractReferences('C#言語 と #タグ').links).toEqual(['タグ']);
	});

	it('normalizes link names with NFC', () => {
		expect(extractReferences('[\u30ab\u3099]').links).toEqual(['\u30ac']);
	});
});
