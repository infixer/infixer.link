import { describe, expect, it } from 'vitest';
import { CreatePageRequest, LIMITS, UpdatePageRequest, v } from './index.ts';

const base = {
	mutationId: '0b8f8a0e-6d8e-4c7e-9a49-6f6b0c7a1e01',
	title: '2026-10-15',
	format: 'link-text-v1',
	source: '今日のメモ\n [読書]'
};

describe('CreatePageRequest', () => {
	it('accepts the design example', () => {
		expect(v.safeParse(CreatePageRequest, base).success).toBe(true);
	});

	it('rejects unknown fields so clients cannot smuggle derived data', () => {
		expect(v.safeParse(CreatePageRequest, { ...base, links: ['x'] }).success).toBe(false);
	});

	it('rejects empty, multi-line and over-long titles', () => {
		for (const title of ['  ', 'a\nb', 'あ'.repeat(LIMITS.titleCodePoints + 1)]) {
			expect(v.safeParse(CreatePageRequest, { ...base, title }).success).toBe(false);
		}
		expect(
			v.safeParse(CreatePageRequest, { ...base, title: '😀'.repeat(LIMITS.titleCodePoints) }).success
		).toBe(true);
	});

	it('rejects CRLF sources, other formats and malformed ids', () => {
		expect(v.safeParse(CreatePageRequest, { ...base, source: 'a\r\nb' }).success).toBe(false);
		expect(v.safeParse(CreatePageRequest, { ...base, format: 'markdown' }).success).toBe(false);
		expect(v.safeParse(CreatePageRequest, { ...base, mutationId: 'nope' }).success).toBe(false);
	});
});

describe('UpdatePageRequest', () => {
	it('requires an integer baseRevision >= 1', () => {
		const { mutationId, title, format, source } = base;
		const body = { mutationId, title, format, source };
		expect(v.safeParse(UpdatePageRequest, { ...body, baseRevision: 12 }).success).toBe(true);
		expect(v.safeParse(UpdatePageRequest, { ...body, baseRevision: 0 }).success).toBe(false);
		expect(v.safeParse(UpdatePageRequest, { ...body, baseRevision: 1.5 }).success).toBe(false);
		expect(v.safeParse(UpdatePageRequest, body).success).toBe(false);
	});
});
