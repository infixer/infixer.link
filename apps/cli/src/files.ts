/**
 * Where exports are written / read. File names never come from titles: only page / asset
 * ids (UUIDs) and fixed names, and every path is checked to stay inside the root
 * (design §13.2: no path traversal).
 */
import { CliError, EXIT } from './errors.ts';

export interface FileStore {
	/** Writes a new file; never overwrites. */
	write(relative: string, data: Uint8Array | string): Promise<void>;
	read(relative: string): Promise<Uint8Array>;
	/** True when the root does not exist or is an empty directory. */
	isEmpty(): Promise<boolean>;
}

const SAFE = /^(?:[a-z-]+\/)?[A-Za-z0-9-]+(?:\.[a-z0-9]+)+$/;

/** Rejects anything but `name.ext` or `dir/name.ext` made of safe characters. */
export function checkRelative(relative: string): string {
	if (!SAFE.test(relative) || relative.includes('..')) {
		throw new CliError(`安全でないファイル名です: ${JSON.stringify(relative)}`, EXIT.error);
	}
	return relative;
}

/** For tests (and the Workers integration test). */
export function memoryStore(files = new Map<string, Uint8Array>()): FileStore & {
	files: Map<string, Uint8Array>;
} {
	const encoder = new TextEncoder();
	return {
		files,
		async write(relative, data) {
			checkRelative(relative);
			if (files.has(relative)) throw new CliError(`既にあります: ${relative}`);
			files.set(relative, typeof data === 'string' ? encoder.encode(data) : data);
		},
		async read(relative) {
			const data = files.get(checkRelative(relative));
			if (!data) throw new CliError(`ファイルがありません: ${relative}`, EXIT.notFound);
			return data;
		},
		async isEmpty() {
			return files.size === 0;
		}
	};
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
