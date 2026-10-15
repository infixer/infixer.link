import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('R2 bindings', () => {
	it('puts and gets an object with metadata', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		await env.PENDING.put('pending/test.png', bytes, {
			httpMetadata: { contentType: 'image/png' }
		});
		const object = await env.PENDING.get('pending/test.png');
		expect(object).not.toBeNull();
		expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
		expect(object!.httpMetadata?.contentType).toBe('image/png');
	});

	it('keeps public and pending buckets separate', async () => {
		await env.PENDING.put('originals/only-pending', 'x');
		expect(await env.MEDIA.get('originals/only-pending')).toBeNull();
	});
});
