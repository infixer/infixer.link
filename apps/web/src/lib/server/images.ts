/**
 * Image validation by content, never by the Content-Type header (design §10.2).
 * Supported: JPEG, PNG, GIF, WebP. SVG and HEIC/AVIF are rejected with a clear reason.
 * Pure module (no Workers APIs) so it can be unit-tested in Node.
 */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const IMAGE_LIMITS = {
	maxBytes: 10 * 1024 * 1024,
	maxPixels: 40_000_000,
	/** Link-card images fetched from other sites. */
	maxPreviewBytes: 5 * 1024 * 1024
} as const;

export const EXTENSION: Record<ImageType, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp'
};

export type SniffResult =
	| { ok: true; type: ImageType; width: number; height: number }
	| { ok: false; reason: 'unsupported' | 'heic' | 'svg' | 'corrupt' | 'too-many-pixels' };

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) =>
	((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return null;
		const marker = b[i + 1];
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			i += 2;
			continue;
		}
		const length = u16be(b, i + 2);
		if (length < 2) return null;
		// SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
		}
		i += 2 + length;
	}
	return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
	const chunk = ascii(b, 12, 4);
	if (chunk === 'VP8X' && b.length >= 30)
		return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
	if (chunk === 'VP8 ' && b.length >= 30)
		return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
	if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
		const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return null;
}

export function sniffImage(bytes: Uint8Array): SniffResult {
	const b = bytes;
	if (b.length < 12) return { ok: false, reason: 'corrupt' };

	let type: ImageType;
	let size: { width: number; height: number } | null = null;

	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		type = 'image/jpeg';
		size = jpegSize(b);
	} else if (u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) {
		type = 'image/png';
		if (b.length >= 24 && ascii(b, 12, 4) === 'IHDR')
			size = { width: u32be(b, 16), height: u32be(b, 20) };
	} else if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') {
		type = 'image/gif';
		size = { width: u16le(b, 6), height: u16le(b, 8) };
	} else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
		type = 'image/webp';
		size = webpSize(b);
	} else if (
		ascii(b, 4, 4) === 'ftyp' &&
		/^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(ascii(b, 8, 4))
	) {
		return { ok: false, reason: 'heic' };
	} else {
		const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart().toLowerCase();
		if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
			return { ok: false, reason: 'svg' };
		}
		return { ok: false, reason: 'unsupported' };
	}

	if (!size || size.width < 1 || size.height < 1) return { ok: false, reason: 'corrupt' };
	if (size.width * size.height > IMAGE_LIMITS.maxPixels)
		return { ok: false, reason: 'too-many-pixels' };
	return { ok: true, type, ...size };
}

export const REJECT_MESSAGE: Record<Exclude<SniffResult, { ok: true }>['reason'], string> = {
	unsupported: '対応していない形式です（JPEG / PNG / GIF / WebP のみ）',
	heic: 'HEIC / AVIF にはまだ対応していません。JPEG で書き出してから貼り付けてください',
	svg: 'SVG はアップロードできません',
	corrupt: '画像を読み取れませんでした',
	'too-many-pixels': '画像が大きすぎます（4000万画素まで）'
};
