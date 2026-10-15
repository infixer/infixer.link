import { describe, expect, it } from 'vitest';
import {
	extractReferences,
	nameKey,
	parse,
	plainLines,
	youtubeEmbedUrl,
	youtubeVideo,
	youtubeWatchUrl
} from './index.ts';

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
			assets: ['550e8400-e29b-41d4-a716-446655440000'],
			thumbnails: ['asset:550e8400-e29b-41d4-a716-446655440000']
		});
	});

	it('keeps links to pages that do not exist yet and dedupes them', () => {
		expect(extractReferences('[未作成] と [未作成] と #未作成').links).toEqual(['未作成']);
	});

	it('ignores URLs, labelled URLs, decorations and math', () => {
		const source = '[https://a.example] [参考 https://b.example] [* 太字] [/ 斜体] [$ x^2]';
		expect(extractReferences(source)).toEqual({
			links: [],
			assets: [],
			thumbnails: []
		});
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

describe('thumbnail candidates', () => {
	const a = '11111111-1111-4111-8111-111111111111';
	const b = '22222222-2222-4222-8222-222222222222';

	it('lists images and URL-only lines in document order, deduped, at most five', () => {
		const source = [
			'本文 [https://example.org 参考] はカードではない',
			'https://example.org/card',
			`画像 [asset:${a}] と [* [asset:${b}]]`,
			'https://youtu.be/dQw4w9WgXcQ',
			'https://example.org/card',
			`\`[asset:${b}]\` はコード`
		].join('\n');
		expect(extractReferences(source).thumbnails).toEqual([
			'url:https://example.org/card',
			`asset:${a}`,
			`asset:${b}`,
			'url:https://youtu.be/dQw4w9WgXcQ'
		]);
		const many = Array.from({ length: 8 }, (_, i) => `https://example.org/${i}`).join('\n');
		expect(extractReferences(many).thumbnails).toHaveLength(5);
	});
});

describe('YouTube', () => {
	it('recognizes watch, short, shorts, embed, live and mobile URLs', () => {
		for (const url of [
			'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
			'https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
			'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
			'https://youtu.be/dQw4w9WgXcQ?si=abc',
			'https://www.youtube.com/shorts/dQw4w9WgXcQ',
			'https://www.youtube.com/embed/dQw4w9WgXcQ',
			'https://www.youtube.com/live/dQw4w9WgXcQ'
		]) {
			expect(youtubeVideo(url), url).toEqual({
				provider: 'youtube',
				id: 'dQw4w9WgXcQ',
				start: 0
			});
		}
	});

	it('reads the start time and rejects look-alikes and bad ids', () => {
		expect(youtubeVideo('https://youtu.be/dQw4w9WgXcQ?t=90')?.start).toBe(90);
		expect(youtubeVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')?.start).toBe(90);
		for (const url of [
			'https://www.youtube.com/watch?v=short',
			'https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onload',
			'https://evil.example/watch?v=dQw4w9WgXcQ',
			'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
			'https://www.youtube.com/channel/UCxxxxxxxxxx',
			'javascript:alert(1)'
		]) {
			expect(youtubeVideo(url), url).toBeNull();
		}
	});

	it('builds player and watch URLs from the id only', () => {
		const video = youtubeVideo('https://youtu.be/dQw4w9WgXcQ?t=42')!;
		expect(youtubeEmbedUrl(video)).toBe(
			'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=42'
		);
		expect(youtubeWatchUrl(video)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
	});

	it('marks URL-only YouTube lines as videos, not inline links', () => {
		const { lines } = parse('https://youtu.be/dQw4w9WgXcQ\n見て https://youtu.be/dQw4w9WgXcQ');
		expect(lines[0]!.video?.id).toBe('dQw4w9WgXcQ');
		expect(lines[1]!.video).toBeUndefined();
	});
});

describe('plainLines', () => {
	it('returns visible text of the first lines without markup, code or blank lines', () => {
		const source = [
			'# 見出し',
			'',
			'[* 太字] と [リンク] #タグ',
			'```',
			'code',
			'```',
			'最後'
		].join('\n');
		expect(plainLines(parse(source))).toEqual(['見出し', '太字 と リンク #タグ', '最後']);
	});

	it('stops at the character budget', () => {
		const lines = plainLines(parse('あ'.repeat(50) + '\n' + 'い'.repeat(50)), 60);
		expect(lines).toEqual(['あ'.repeat(50), `${'い'.repeat(10)}…`]);
	});
});
