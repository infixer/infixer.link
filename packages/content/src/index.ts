/**
 * link-text-v1 helpers shared by the server, the editor and the CLI.
 *
 * Phase 1 only needs what the save path stores: normalized page names and the
 * internal-link / asset references of a source. The full grammar (render nodes,
 * code blocks, decorations) arrives with the Phase 3 parser and must keep the
 * results of `extractReferences` stable for existing fixtures.
 */

export const FORMAT = 'link-text-v1';

/** Name key used for titles, aliases and link targets: NFC + trim. Case is preserved. */
export function nameKey(name: string): string {
	return name.normalize('NFC').trim();
}

export interface References {
	/** Internal link targets as name keys, unique, in first-seen order. */
	links: string[];
	/** Asset ids referenced via `[asset:UUID]`, unique, lower-cased. */
	assets: string[];
}

const ASSET_RE = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// Cosense-style decorations such as `[* bold]`, `[/ italic]`, `[- strike]`.
const DECORATION_RE = /^[*/\-_!%{}&~<>]+\s/;
const BRACKET_RE = /\[([^[\]\n]+)\]/g;
// `#tag` at line start or after whitespace; ends at whitespace or a bracket.
const TAG_RE = /(^|\s)#([^\s[\]#]+)/g;
const CODE_SPAN_RE = /`[^`\n]*`/g;

function bracketTarget(inner: string): { link?: string; asset?: string } {
	const asset = ASSET_RE.exec(inner);
	if (asset) return { asset: asset[1].toLowerCase() };
	if (URL_RE.test(inner) || DECORATION_RE.test(inner) || inner.startsWith('$ ')) return {};
	// `[label https://...]` is an external link with a label.
	if (/\s[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(inner)) return {};
	const key = nameKey(inner);
	return key ? { link: key } : {};
}

export function extractReferences(source: string): References {
	const links = new Set<string>();
	const assets = new Set<string>();

	for (const rawLine of source.split('\n')) {
		// Inline code never produces references.
		const line = rawLine.replace(CODE_SPAN_RE, (m) => ' '.repeat(m.length));

		for (const match of line.matchAll(BRACKET_RE)) {
			const target = bracketTarget(match[1]);
			if (target.link) links.add(target.link);
			if (target.asset) assets.add(target.asset);
		}

		const withoutBrackets = line.replace(BRACKET_RE, (m) => ' '.repeat(m.length));
		for (const match of withoutBrackets.matchAll(TAG_RE)) {
			const key = nameKey(match[2]);
			if (key) links.add(key);
		}
	}

	return { links: [...links], assets: [...assets] };
}
