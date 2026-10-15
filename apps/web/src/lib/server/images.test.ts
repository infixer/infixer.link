import { describe, expect, it } from 'vitest';
import { sniffImage } from './images';

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p))
	);
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const png = (w: number, h: number) =>
	bytes(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		be32(13),
		'IHDR',
		be32(w),
		be32(h),
		[8, 6, 0, 0, 0]
	);

describe('sniffImage', () => {
	it('reads PNG dimensions', () => {
		expect(sniffImage(png(640, 480))).toEqual({
			ok: true,
			type: 'image/png',
			width: 640,
			height: 480
		});
	});

	it('reads GIF dimensions', () => {
		expect(sniffImage(bytes('GIF89a', [0x20, 0x03, 0x58, 0x02], [0, 0, 0, 0]))).toMatchObject({
			type: 'image/gif',
			width: 800,
			height: 600
		});
	});

	it('reads JPEG dimensions past APP segments', () => {
		const app1 = [0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6];
		const sof0 = [
			0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0
		];
		expect(sniffImage(bytes([0xff, 0xd8], app1, sof0))).toEqual({
			ok: true,
			type: 'image/jpeg',
			width: 1920,
			height: 1080
		});
	});

	it('reads WebP (VP8X) dimensions', () => {
		const w = 1199;
		const h = 899;
		const b = bytes(
			'RIFF',
			[0, 0, 0, 0],
			'WEBP',
			'VP8X',
			[10, 0, 0, 0],
			[0, 0, 0, 0],
			[w & 255, (w >> 8) & 255, 0],
			[h & 255, (h >> 8) & 255, 0]
		);
		expect(sniffImage(b)).toMatchObject({ type: 'image/webp', width: 1200, height: 900 });
	});

	it('rejects SVG, HEIC, text with a fake image name, truncated and huge images', () => {
		expect(
			sniffImage(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))
		).toEqual({
			ok: false,
			reason: 'svg'
		});
		expect(sniffImage(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0]))).toEqual({
			ok: false,
			reason: 'heic'
		});
		expect(sniffImage(bytes('just some text pretending'))).toEqual({
			ok: false,
			reason: 'unsupported'
		});
		expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({
			ok: false,
			reason: 'corrupt'
		});
		expect(sniffImage(png(10000, 5000))).toEqual({ ok: false, reason: 'too-many-pixels' });
	});
});
