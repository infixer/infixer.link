/** Tiny valid images for tests (no binary fixtures in the repo). */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A real, decodable 1×1 PNG with an optional variant byte so hashes differ. */
export function pngBytes(variant = 0): Uint8Array<ArrayBuffer> {
	const b64 =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
	const base = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	if (variant === 0) return base;
	// Append a harmless trailing chunk after IEND so the file hash changes but stays valid.
	const extra = new Uint8Array([
		...be32(1),
		...[0x74, 0x45, 0x58, 0x74],
		variant & 255,
		...be32(variant)
	]);
	const out = new Uint8Array(base.length + extra.length);
	out.set(base);
	out.set(extra, base.length);
	return out;
}
