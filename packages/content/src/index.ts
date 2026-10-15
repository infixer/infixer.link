/**
 * link-text-v1 helpers shared by the server, the editor and the CLI (ADR 0009).
 */
import { parse } from './parse.ts';

export { parse, parseInline, nameKey, isSafeUrl } from './parse.ts';
export type { Inline, Line, LineKind, Parsed } from './parse.ts';

export const FORMAT = 'link-text-v1';

export interface References {
	/** Internal link targets as name keys, unique, in first-seen order. */
	links: string[];
	/** Asset ids referenced via `[asset:UUID]`, unique, lower-cased. */
	assets: string[];
}

/** What the save path stores: link targets and asset references (code is never scanned). */
export function extractReferences(source: string): References {
	const { links, assets } = parse(source);
	return { links, assets };
}
