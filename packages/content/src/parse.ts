/**
 * link-text-v1 parser (ADR 0009: Cosense links + Markdown formatting).
 *
 * Pure, linear-time, line-based. Every node carries offsets relative to its line so the
 * same result drives the SSR renderer and the editor's decorations. Unknown syntax is
 * kept as text — nothing is ever dropped.
 *
 * Block (per line):
 *   ```lang / ```            fenced code (Markdown)        code:name + indented lines (Cosense)
 *   # .. ######              heading (Markdown)
 *   - * + / 1.               list item (Markdown)          leading spaces = indent level (Cosense)
 *   > quote                  ---  horizontal rule
 *   a line that is only a URL → link card
 * Inline:
 *   `code`  **strong**  *em* _em_  ~~strike~~  [* deco] [** deco] [/ em] [- strike] [_ underline]
 *   [page name]  #tag  [label](https://..)  [https://.. label]  [label https://..]  bare https://..
 *   [asset:UUID]  [$ math]  \escape
 */

import { youtubeVideo, type Video } from './youtube.ts';

export type Inline =
	| { type: 'text'; from: number; to: number; text: string }
	| { type: 'code'; from: number; to: number; text: string }
	| {
			type: 'strong' | 'em' | 'strike' | 'underline';
			from: number;
			to: number;
			/** Range of the inner content (markers are outside it). */
			innerFrom: number;
			innerTo: number;
			/** Cosense `[** x]` nesting depth for strong (1 = normal bold). */
			weight?: number;
			children: Inline[];
	  }
	| { type: 'link'; from: number; to: number; name: string; innerFrom: number; innerTo: number }
	| { type: 'tag'; from: number; to: number; name: string }
	| {
			type: 'url';
			from: number;
			to: number;
			url: string;
			label: string;
			/** Range of the visible label; equals the URL range for bare URLs. */
			innerFrom: number;
			innerTo: number;
	  }
	| { type: 'asset'; from: number; to: number; id: string }
	| { type: 'math'; from: number; to: number; text: string; innerFrom: number; innerTo: number };

export type LineKind =
	| 'text'
	| 'blank'
	| 'heading'
	| 'list'
	| 'quote'
	| 'hr'
	| 'card'
	| 'code-open'
	| 'code'
	| 'code-close';

export interface Line {
	index: number;
	text: string;
	kind: LineKind;
	/** Visual nesting level: 0 = top level. */
	level: number;
	/** Offset where the visible content starts (after indentation and block markers). */
	contentFrom: number;
	heading?: number;
	ordered?: number;
	/** For card lines. */
	url?: string;
	/** For card lines whose URL is a video (rendered as an embedded player). */
	video?: Video;
	/** For code-open lines: language or Cosense file name. */
	lang?: string;
	inlines: Inline[];
}

export interface Parsed {
	lines: Line[];
	/** Internal link targets (name keys), unique, first-seen order. */
	links: string[];
	/** Asset ids, unique, lower-case. */
	assets: string[];
	/** URLs rendered as link cards, unique. */
	cards: string[];
	/**
	 * Candidates for the page's thumbnail in document order (up to 5): `asset:{id}` for
	 * images and `url:{url}` for cards / videos. The first one with an image is used.
	 */
	thumbnails: string[];
}

const MAX_INLINE_DEPTH = 4;
const MAX_THUMBNAILS = 5;
const URL_RE = /^https?:\/\/[^\s<>"'`[\]]+/i;
const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i;
const ASSET_RE = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COSENSE_DECO = /^([*/\-_]+)\s/;

/** Name key used for titles, aliases and link targets: NFC + trim. Case is preserved. */
export function nameKey(name: string): string {
	return name.normalize('NFC').trim();
}

export function isSafeUrl(url: string): boolean {
	return SAFE_SCHEME.test(url);
}

/** Drops trailing punctuation that usually ends a sentence rather than the URL. */
function trimUrl(url: string): string {
	let end = url.length;
	while (end > 0) {
		const ch = url[end - 1];
		if ('.,;:!?。、，．！？」』】'.includes(ch)) end--;
		else if (ch === ')' && url.slice(0, end).split('(').length <= url.slice(0, end).split(')').length - 1) end--;
		else break;
	}
	return url.slice(0, end);
}

function isWordBoundary(text: string, i: number): boolean {
	return i === 0 || /[\s(（「『【、。,]/.test(text[i - 1]);
}

/**
 * Parses inline syntax in text[from, to). Offsets are relative to the line.
 * Linear: every branch either consumes characters or falls through to plain text.
 */
export function parseInline(text: string, from = 0, to = text.length, depth = 0): Inline[] {
	const out: Inline[] = [];
	let textStart = from;
	let i = from;

	const flush = (end: number) => {
		if (end > textStart) {
			const last = out.at(-1);
			if (last?.type === 'text' && last.to === textStart) {
				last.to = end;
				last.text += text.slice(textStart, end);
			} else {
				out.push({ type: 'text', from: textStart, to: end, text: text.slice(textStart, end) });
			}
		}
	};
	const emit = (node: Inline) => {
		flush(node.from);
		out.push(node);
		i = node.to;
		textStart = node.to;
	};

	while (i < to) {
		const c = text[i];

		// \x → literal x
		if (c === '\\' && i + 1 < to && /[\\`*_~[\]#()!-]/.test(text[i + 1])) {
			flush(i);
			out.push({ type: 'text', from: i, to: i + 2, text: text[i + 1] });
			i += 2;
			textStart = i;
			continue;
		}

		if (c === '`') {
			const close = text.indexOf('`', i + 1);
			if (close !== -1 && close < to) {
				emit({ type: 'code', from: i, to: close + 1, text: text.slice(i + 1, close) });
				continue;
			}
		}

		if (depth < MAX_INLINE_DEPTH && (c === '*' || c === '~' || c === '_')) {
			const node = delimited(text, i, to, depth);
			if (node) {
				emit(node);
				continue;
			}
		}

		if (c === '[') {
			const node = bracket(text, i, to, depth);
			if (node) {
				emit(node);
				continue;
			}
		}

		if (c === '#' && isWordBoundary(text, i)) {
			const m = /^#([^\s[\]#`]+)/.exec(text.slice(i, to));
			if (m) {
				const name = nameKey(m[1]);
				if (name) {
					emit({ type: 'tag', from: i, to: i + m[0].length, name });
					continue;
				}
			}
		}

		if ((c === 'h' || c === 'H') && isWordBoundary(text, i)) {
			const m = URL_RE.exec(text.slice(i, to));
			if (m) {
				const url = trimUrl(m[0]);
				emit({ type: 'url', from: i, to: i + url.length, url, label: url, innerFrom: i, innerTo: i + url.length });
				continue;
			}
		}

		i++;
	}
	flush(to);
	// Merge adjacent text nodes (escapes produce their own) so consumers see one run.
	const merged: Inline[] = [];
	for (const node of out) {
		const last = merged.at(-1);
		if (node.type === 'text' && last?.type === 'text' && last.to === node.from) {
			merged[merged.length - 1] = { ...last, to: node.to, text: last.text + node.text };
		} else {
			merged.push(node);
		}
	}
	return merged;
}

/** **strong**, *em*, _em_, ~~strike~~ with a closing marker on the same line. */
function delimited(text: string, i: number, to: number, depth: number): Inline | null {
	const two = text.slice(i, i + 2);
	let marker: string;
	let type: 'strong' | 'em' | 'strike';
	if (two === '**') [marker, type] = ['**', 'strong'];
	else if (two === '~~') [marker, type] = ['~~', 'strike'];
	else if (text[i] === '*' || text[i] === '_') [marker, type] = [text[i], 'em'];
	else return null;

	const innerFrom = i + marker.length;
	// Opening marker must be followed by non-space; `_` only at a word start (snake_case stays text).
	if (innerFrom >= to || /\s/.test(text[innerFrom])) return null;
	if (marker === '_' && i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1])) return null;
	let close = text.indexOf(marker, innerFrom + 1);
	while (close !== -1 && close < to && /\s/.test(text[close - 1])) close = text.indexOf(marker, close + 1);
	if (close === -1 || close + marker.length > to) return null;
	if (marker === '*' && text[close + 1] === '*') return null;
	return {
		type,
		from: i,
		to: close + marker.length,
		innerFrom,
		innerTo: close,
		children: parseInline(text, innerFrom, close, depth + 1)
	};
}

/** Everything that starts with `[`. Returns null to treat `[` as text. */
function bracket(text: string, i: number, to: number, depth: number): Inline | null {
	const close = text.indexOf(']', i + 1);
	if (close === -1 || close >= to) return null;
	const inner = text.slice(i + 1, close);
	if (inner.includes('[') || inner.trim() === '') return null;

	// [label](url) — Markdown link
	if (text[close + 1] === '(') {
		const end = text.indexOf(')', close + 2);
		if (end !== -1 && end < to) {
			const url = text.slice(close + 2, end).trim();
			if (isSafeUrl(url) && !/\s/.test(url)) {
				return { type: 'url', from: i, to: end + 1, url, label: inner, innerFrom: i + 1, innerTo: close };
			}
		}
	}

	const asset = ASSET_RE.exec(inner);
	if (asset) return { type: 'asset', from: i, to: close + 1, id: asset[1].toLowerCase() };

	if (inner.startsWith('$ ')) {
		return { type: 'math', from: i, to: close + 1, text: inner.slice(2), innerFrom: i + 3, innerTo: close };
	}

	// Cosense decoration: [* x] [** x] [/ x] [- x] [_ x]
	const deco = COSENSE_DECO.exec(inner);
	if (deco && depth < MAX_INLINE_DEPTH) {
		const marks = deco[1];
		const innerFrom = i + 1 + deco[0].length;
		const children = parseInline(text, innerFrom, close, depth + 1);
		const type = marks.includes('*')
			? 'strong'
			: marks.includes('/')
				? 'em'
				: marks.includes('-')
					? 'strike'
					: 'underline';
		return {
			type,
			from: i,
			to: close + 1,
			innerFrom,
			innerTo: close,
			weight: type === 'strong' ? marks.split('*').length - 1 : undefined,
			children
		};
	}

	// [https://url label] or [label https://url] or [https://url]
	const parts = inner.split(/\s+/);
	if (isSafeUrl(parts[0])) {
		const label = inner.slice(parts[0].length).trim();
		const labelFrom = i + 1 + inner.indexOf(label, parts[0].length);
		return {
			type: 'url',
			from: i,
			to: close + 1,
			url: parts[0],
			label: label || parts[0],
			innerFrom: label ? labelFrom : i + 1,
			innerTo: label ? labelFrom + label.length : i + 1 + parts[0].length
		};
	}
	if (parts.length > 1 && isSafeUrl(parts.at(-1)!)) {
		const url = parts.at(-1)!;
		const label = inner.slice(0, inner.lastIndexOf(url)).trim();
		return { type: 'url', from: i, to: close + 1, url, label, innerFrom: i + 1, innerTo: i + 1 + label.length };
	}

	const name = nameKey(inner);
	if (!name) return null;
	return { type: 'link', from: i, to: close + 1, name, innerFrom: i + 1, innerTo: close };
}

function leadingSpaces(text: string): number {
	let n = 0;
	while (n < text.length && (text[n] === ' ' || text[n] === '\t' || text[n] === '　')) n++;
	return n;
}

export function parse(source: string): Parsed {
	const rawLines = source.split('\n');
	const lines: Line[] = [];
	const links = new Set<string>();
	const assets = new Set<string>();
	const cards = new Set<string>();
	const thumbnails: string[] = [];

	let fence: { indent: number; marker: string } | null = null;
	let cosenseCode: { indent: number } | null = null;

	rawLines.forEach((text, index) => {
		const indent = leadingSpaces(text);
		const rest = text.slice(indent);
		const base = { index, text, level: indent, contentFrom: indent, inlines: [] as Inline[] };

		// Inside a fenced code block
		if (fence) {
			if (rest.startsWith(fence.marker) && rest.slice(fence.marker.length).trim() === '') {
				fence = null;
				lines.push({ ...base, kind: 'code-close', level: 0, contentFrom: text.length });
			} else {
				lines.push({ ...base, kind: 'code', level: 0, contentFrom: 0 });
			}
			return;
		}
		// Inside a Cosense code: block (lines indented deeper than the code: line)
		if (cosenseCode) {
			if (text.trim() !== '' && indent > cosenseCode.indent) {
				lines.push({ ...base, kind: 'code', level: cosenseCode.indent, contentFrom: cosenseCode.indent + 1 });
				return;
			}
			cosenseCode = null;
		}

		const fenceOpen = /^(`{3,}|~{3,})\s*([^`\s]*)\s*$/.exec(rest);
		if (fenceOpen) {
			fence = { indent, marker: fenceOpen[1] };
			lines.push({ ...base, kind: 'code-open', level: 0, contentFrom: text.length, lang: fenceOpen[2] || undefined });
			return;
		}
		const codeLabel = /^code:(\S+)\s*$/.exec(rest);
		if (codeLabel) {
			cosenseCode = { indent };
			lines.push({ ...base, kind: 'code-open', contentFrom: text.length, lang: codeLabel[1] });
			return;
		}

		if (rest === '') {
			lines.push({ ...base, kind: 'blank', level: 0 });
			return;
		}

		let line: Line;
		const heading = /^(#{1,6})\s+/.exec(rest);
		const list = /^(?:([-*+])|(\d{1,9})[.)])\s+/.exec(rest);
		if (indent === 0 && heading) {
			line = { ...base, kind: 'heading', heading: heading[1].length, level: 0, contentFrom: heading[0].length };
		} else if (/^(-{3,}|\*{3,}|_{3,})$/.test(rest.trim()) && indent === 0) {
			lines.push({ ...base, kind: 'hr', level: 0, contentFrom: text.length });
			return;
		} else if (list) {
			line = {
				...base,
				kind: 'list',
				level: indent + 1,
				contentFrom: indent + list[0].length,
				ordered: list[2] ? Number(list[2]) : undefined
			};
		} else if (rest.startsWith('> ') || rest === '>') {
			line = { ...base, kind: 'quote', contentFrom: indent + Math.min(2, rest.length) };
		} else {
			line = { ...base, kind: 'text' };
		}

		line.inlines = parseInline(text, line.contentFrom, text.length);

		// A line whose only content is a URL becomes a link card.
		const only = line.inlines.length === 1 ? line.inlines[0] : null;
		const onlyUrl =
			only?.type === 'url' &&
			only.label === only.url &&
			only.from === line.contentFrom &&
			only.to === text.trimEnd().length;
		if (onlyUrl && (line.kind === 'text' || line.kind === 'list')) {
			// Top-level and indented URL-only lines render as cards; list items keep their bullet.
			if (line.kind === 'text') line.kind = 'card';
			line.url = only.url;
			const video = youtubeVideo(only.url);
			if (video) line.video = video;
			cards.add(only.url);
			if (thumbnails.length < MAX_THUMBNAILS) thumbnails.push(`url:${only.url}`);
		} else if (thumbnails.length < MAX_THUMBNAILS) {
			collectAssets(line.inlines, thumbnails);
		}
		collect(line.inlines, links, assets);
		lines.push(line);
	});

	return {
		lines,
		links: [...links],
		assets: [...assets],
		cards: [...cards],
		thumbnails: [...new Set(thumbnails)].slice(0, MAX_THUMBNAILS)
	};
}

function collectAssets(inlines: Inline[], out: string[]) {
	for (const node of inlines) {
		if (node.type === 'asset') out.push(`asset:${node.id}`);
		else if ('children' in node) collectAssets(node.children, out);
	}
}

function collect(inlines: Inline[], links: Set<string>, assets: Set<string>) {
	for (const node of inlines) {
		if (node.type === 'link' || node.type === 'tag') links.add(node.name);
		else if (node.type === 'asset') assets.add(node.id);
		else if ('children' in node) collect(node.children, links, assets);
	}
}
