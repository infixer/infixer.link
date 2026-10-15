/** FileStore on the local disk (Node only; files.ts stays runtime-neutral). */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT } from './errors.ts';
import { checkRelative, type FileStore } from './files.ts';

export function nodeStore(root: string): FileStore {
	const base = path.resolve(root);
	const resolve = (relative: string) => {
		const full = path.resolve(base, checkRelative(relative));
		if (!full.startsWith(base + path.sep)) {
			throw new CliError(`出力先の外には書き込みません: ${relative}`, EXIT.error);
		}
		return full;
	};
	return {
		async write(relative, data) {
			const full = resolve(relative);
			await mkdir(path.dirname(full), { recursive: true });
			await writeFile(full, data, { flag: 'wx' });
		},
		async read(relative) {
			return new Uint8Array(await readFile(resolve(relative)));
		},
		async isEmpty() {
			try {
				return (await readdir(base)).length === 0;
			} catch {
				return true;
			}
		}
	};
}
