import { describe, expect, it } from 'vitest';
import { matchLines, merge3, mergeValue, resolve } from './index.ts';

const lines = (...xs: string[]) => xs.join('\n');

describe('matchLines', () => {
	it('matches the longest common subsequence of lines', () => {
		const a = ['a', 'b', 'c', 'd', 'e'];
		const b = ['a', 'x', 'c', 'd', 'y', 'e'];
		expect([...matchLines(a, b)]).toEqual([0, -1, 2, 3, 5]);
	});

	it('handles empty inputs and identical inputs', () => {
		expect([...matchLines([], ['a'])]).toEqual([]);
		expect([...matchLines(['a'], [])]).toEqual([-1]);
		expect([...matchLines(['a', 'b'], ['a', 'b'])]).toEqual([0, 1]);
	});

	it('keeps matches strictly increasing on repetitive text', () => {
		const a = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 'x' : `l${i % 7}`));
		const b = [...a].reverse();
		const m = [...matchLines(a, b)].filter((x) => x >= 0);
		for (let i = 1; i < m.length; i++) expect(m[i]!).toBeGreaterThan(m[i - 1]!);
	});
});

describe('merge3', () => {
	const base = lines('# 読書', '一行目', '二行目', '三行目', '四行目');

	it('merges edits to different lines without conflicts', () => {
		const ours = lines('# 読書', '一行目（端末で修正）', '二行目', '三行目', '四行目');
		const theirs = lines('# 読書', '一行目', '二行目', '三行目', '四行目', '五行目（サーバーで追加）');
		const r = merge3(base, ours, theirs);
		expect(r.conflicts).toBe(0);
		expect(r.merged).toBe(
			lines('# 読書', '一行目（端末で修正）', '二行目', '三行目', '四行目', '五行目（サーバーで追加）')
		);
		expect(r.chunks.map((c) => c.kind)).toEqual(['stable', 'ours', 'stable', 'theirs']);
	});

	it('reports a conflict when both sides change the same lines differently', () => {
		const ours = lines('# 読書', '一行目', '二行目は端末', '三行目', '四行目');
		const theirs = lines('# 読書', '一行目', '二行目はサーバー', '三行目', '四行目');
		const r = merge3(base, ours, theirs);
		expect(r.conflicts).toBe(1);
		expect(r.merged).toBeNull();
		expect(r.chunks[1]).toEqual({
			kind: 'conflict',
			base: ['二行目'],
			ours: ['二行目は端末'],
			theirs: ['二行目はサーバー']
		});
		expect(resolve(r.chunks, ['theirs'])).toBe(theirs);
		expect(resolve(r.chunks, ['ours'])).toBe(ours);
		expect(resolve(r.chunks, ['both'])).toBe(
			lines('# 読書', '一行目', '二行目は端末', '二行目はサーバー', '三行目', '四行目')
		);
	});

	it('treats identical changes on both sides as one change', () => {
		const same = lines('# 読書', '一行目', '同じ修正', '三行目', '四行目');
		const r = merge3(base, same, same);
		expect(r.conflicts).toBe(0);
		expect(r.merged).toBe(same);
		expect(r.chunks.some((c) => c.kind === 'both')).toBe(true);
	});

	it('conflicts on insertions at the same place, and on delete vs edit', () => {
		const insertA = lines('# 読書', 'A', '一行目', '二行目', '三行目', '四行目');
		const insertB = lines('# 読書', 'B', '一行目', '二行目', '三行目', '四行目');
		expect(merge3(base, insertA, insertB).conflicts).toBe(1);

		const deleted = lines('# 読書', '一行目', '三行目', '四行目');
		const edited = lines('# 読書', '一行目', '二行目を修正', '三行目', '四行目');
		const r = merge3(base, deleted, edited);
		expect(r.conflicts).toBe(1);
		expect(r.chunks[1]).toMatchObject({ ours: [], theirs: ['二行目を修正'] });
	});

	it('keeps a deletion on one side when the other side did not touch the lines', () => {
		const deleted = lines('# 読書', '一行目', '四行目');
		const appended = lines('# 読書', '一行目', '二行目', '三行目', '四行目', '追記');
		expect(merge3(base, deleted, appended).merged).toBe(lines('# 読書', '一行目', '四行目', '追記'));
	});

	it('works from an empty base (both sides wrote a new page)', () => {
		const r = merge3('', '端末の日記', 'サーバーの日記');
		expect(r.conflicts).toBe(1);
		expect(resolve(r.chunks, ['both'])).toBe(lines('端末の日記', 'サーバーの日記'));
	});

	it('is fast enough for a 10,000-line page with scattered edits', () => {
		const big = Array.from({ length: 10_000 }, (_, i) => `行 ${i} の本文`);
		const ours = [...big];
		const theirs = [...big];
		for (let i = 0; i < 10_000; i += 1000) ours[i] = `端末 ${i}`;
		for (let i = 500; i < 10_000; i += 1000) theirs[i] = `サーバー ${i}`;
		const t = performance.now();
		const r = merge3(big.join('\n'), ours.join('\n'), theirs.join('\n'));
		expect(performance.now() - t).toBeLessThan(500);
		expect(r.conflicts).toBe(0);
		expect(r.merged!.split('\n')[500]).toBe('サーバー 500');
		expect(r.merged!.split('\n')[1000]).toBe('端末 1000');
	});
});

describe('mergeValue', () => {
	it('takes the side that changed, and reports changes on both sides', () => {
		expect(mergeValue('a', 'a', 'b')).toBe('b');
		expect(mergeValue('a', 'c', 'a')).toBe('c');
		expect(mergeValue('a', 'd', 'd')).toBe('d');
		expect(mergeValue('a', 'c', 'b')).toBeNull();
	});
});
