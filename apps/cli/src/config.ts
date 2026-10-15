/**
 * Where the CLI finds the site and its token (design §9.6: environment variable or a
 * local credential file; never in sources, Git or arguments).
 *
 *   INFIXER_URL / INFIXER_TOKEN, else $XDG_CONFIG_HOME/infixer/config.json (mode 0600).
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_URL = 'https://infixer.link';

export interface Config {
	url: string;
	token?: string;
}

export function configPath(env = process.env): string {
	const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
	return path.join(base, 'infixer', 'config.json');
}

export async function loadConfig(env = process.env): Promise<Config> {
	let file: Partial<Config> = {};
	try {
		file = JSON.parse(await readFile(configPath(env), 'utf8')) as Partial<Config>;
	} catch {
		// no file yet
	}
	return {
		url: env.INFIXER_URL || file.url || DEFAULT_URL,
		token: env.INFIXER_TOKEN || file.token
	};
}

export async function saveConfig(config: Config, env = process.env): Promise<string> {
	const file = configPath(env);
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600
	});
	await chmod(file, 0o600);
	return file;
}

export async function removeConfig(env = process.env): Promise<void> {
	await rm(configPath(env), { force: true });
}
