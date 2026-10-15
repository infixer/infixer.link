/**
 * link-text-v1 helpers shared by the server, the editor and the CLI (ADR 0009).
 */
import { parse, type Parsed } from './parse.ts';

export { parse, parseInline, nameKey, isSafeUrl } from './parse.ts';
export type { Inline, Line, LineKind, Parsed } from './parse.ts';
export {
	youtubeVideo,
	youtubeWatchUrl,
	youtubeEmbedUrl,
	youtubeThumbnailUrl,
	type Video
} from './youtube.ts';

export const FORMAT = 'link-text-v1';

export interface References {
	/** Internal link targets as name keys, unique, in first-seen order. */
	links: string[];
	/** Asset ids referenced via `[asset:UUID]`, unique, lower-cased. */
	assets: string[];
	/** Thumbnail candidates in document order (see Parsed.thumbnails). */
	thumbnails: string[];
}

/** What the save path stores: links, asset references and thumbnail candidates. */
export function extractReferences(source: string): References {
	const { links, assets, thumbnails } = parse(source);
	return { links, assets, thumbnails };
}

/**
 * Visible text of the first lines (links as their names, markup removed), for
 * descriptions and list cards. Code blocks, blank lines and card / video lines are skipped.
 */
export function plainLines(parsed: Parsed, maxChars = 160): string[] {
	const out: string[] = [];
	let total = 0;
	const visit = (nodes: Parsed['lines'][number]['inlines'], parts: string[]) => {
		for (const n of nodes) {
			if (n.type === 'text' || n.type === 'code' || n.type === 'math') parts.push(n.text);
			else if (n.type === 'link') parts.push(n.name);
			else if (n.type === 'tag') parts.push(`#${n.name}`);
			else if (n.type === 'url') parts.push(n.label);
			else if ('children' in n) visit(n.children, parts);
		}
	};
	for (const line of parsed.lines) {
		if (total >= maxChars) break;
		if (line.kind.startsWith('code') || ['blank', 'hr', 'card'].includes(line.kind)) continue;
		const parts: string[] = [];
		visit(line.inlines, parts);
		const text = parts.join('').replace(/\s+/g, ' ').trim();
		if (!text) continue;
		const room = maxChars - total;
		out.push([...text].length > room ? `${[...text].slice(0, room).join('')}…` : text);
		total += [...text].length;
	}
	return out;
}
