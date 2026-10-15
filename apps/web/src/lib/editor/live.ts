/**
 * Cosense-style live preview for CodeMirror (ADR 0009, design §4.2).
 *
 * - The line(s) holding the cursor show raw text (with muted syntax) so the selection and
 *   IME never fight hidden characters.
 * - Every other line looks like the read view: same classes (content.css), syntax markers
 *   hidden with replace decorations, links clickable, URL-only lines shown as link cards.
 * - `[` / `#` complete page titles; completion never runs while an IME is composing.
 */
import {
	EditorSelection,
	EditorState,
	StateEffect,
	StateField,
	type Extension,
	type Range
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
	type CompletionContext,
	type CompletionResult
} from '@codemirror/autocomplete';
import {
	parse,
	youtubeEmbedUrl,
	youtubeWatchUrl,
	type Inline,
	type Line,
	type Parsed,
	type Video
} from '@infixer-link/content';
import type {
	AssetDto,
	LinkPreviewDto,
	PageRefDto,
	TitleSuggestionDto
} from '@infixer-link/contracts';
import { lineClass, missingHref, pageHref } from '../content/classes.ts';

export interface LiveData {
	names: Record<string, PageRefDto>;
	previews: Record<string, LinkPreviewDto>;
	assets: Record<string, AssetDto>;
}

/** Local state of an image being uploaded from this editor (uploads.svelte.ts). */
export interface LocalImage {
	status: 'uploading' | 'failed';
	preview: string;
	error?: string;
}

export interface LiveOptions {
	data: LiveData;
	/** Navigate to an internal page (same tab) or an external URL (new tab). */
	navigate: (href: string, external: boolean) => void;
	/** Looks up names / previews that are not known yet; resolves with additions. */
	fetchMissing: (missing: { names: string[]; urls: string[] }) => Promise<Partial<LiveData>>;
	suggest: (query: string, signal: AbortSignal) => Promise<TitleSuggestionDto[]>;
	localImage: (assetId: string) => LocalImage | undefined;
}

/** New names / previews arrived: rebuild decorations. */
const dataChanged = StateEffect.define<LiveData>();

/** Lines are only "being edited" while the editor has focus; unfocused, everything looks rendered. */
const focusChanged = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
	create: () => false,
	update: (value, tr) => {
		for (const e of tr.effects) if (e.is(focusChanged)) return e.value;
		return value;
	}
});

const parsedField = StateField.define<Parsed>({
	create: (state) => parse(state.doc.toString()),
	update: (value, tr) => (tr.docChanged ? parse(tr.state.doc.toString()) : value)
});

class CardWidget extends WidgetType {
	constructor(
		readonly url: string,
		readonly preview: LinkPreviewDto
	) {
		super();
	}
	eq(other: CardWidget) {
		return other.url === this.url && other.preview.title === this.preview.title;
	}
	toDOM() {
		const a = document.createElement('a');
		a.className = 'card';
		a.href = this.url;
		a.target = '_blank';
		a.rel = 'noopener nofollow ugc';
		a.dataset.href = this.url;
		a.dataset.ext = '1';
		const text = document.createElement('span');
		text.className = 'card-text';
		const title = document.createElement('span');
		title.className = 'card-title';
		title.textContent = this.preview.title ?? this.url;
		text.appendChild(title);
		if (this.preview.description) {
			const desc = document.createElement('span');
			desc.className = 'card-desc';
			desc.textContent = this.preview.description;
			text.appendChild(desc);
		}
		const host = document.createElement('span');
		host.className = 'card-host';
		host.textContent = this.preview.siteName ?? this.preview.host;
		text.appendChild(host);
		a.appendChild(text);
		if (this.preview.image) {
			a.classList.add('has-image');
			a.appendChild(
				imageElement(
					this.preview.image.url,
					this.preview.image.width,
					this.preview.image.height,
					'card-image'
				)
			);
		}
		return a;
	}
	ignoreEvent() {
		return false;
	}
}

/** Same DOM as Video.svelte: thumbnail + play button; the player loads on press. */
class VideoWidget extends WidgetType {
	constructor(
		readonly video: Video,
		readonly preview: LinkPreviewDto | undefined
	) {
		super();
	}
	eq(other: VideoWidget) {
		return (
			other.video.id === this.video.id &&
			other.video.start === this.video.start &&
			other.preview?.title === this.preview?.title &&
			other.preview?.image?.url === this.preview?.image?.url
		);
	}
	toDOM() {
		const wrap = document.createElement('span');
		wrap.className = 'video';
		wrap.dataset.testid = 'video';
		const title = this.preview?.title ?? 'YouTube の動画';
		const a = document.createElement('a');
		a.className = 'video-facade';
		a.href = youtubeWatchUrl(this.video);
		a.target = '_blank';
		a.rel = 'noopener nofollow ugc';
		a.setAttribute('aria-label', `${title}を再生`);
		if (this.preview?.image) {
			const { url, width, height } = this.preview.image;
			a.appendChild(imageElement(url, width, height, 'video-poster'));
		}
		const play = document.createElement('span');
		play.className = 'video-play';
		play.setAttribute('aria-hidden', 'true');
		a.appendChild(play);
		if (this.preview?.title) {
			const label = document.createElement('span');
			label.className = 'video-title';
			label.textContent = this.preview.title;
			a.appendChild(label);
		}
		a.addEventListener('click', (event) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
				return;
			event.preventDefault();
			const frame = document.createElement('iframe');
			frame.className = 'video-frame';
			frame.src = youtubeEmbedUrl(this.video);
			frame.title = title;
			frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
			frame.allowFullscreen = true;
			frame.referrerPolicy = 'strict-origin-when-cross-origin';
			a.replaceWith(frame);
		});
		wrap.appendChild(a);
		return wrap;
	}
	/** The player handles its own clicks; the editor does not move the cursor into it. */
	ignoreEvent() {
		return true;
	}
}

function imageElement(src: string, width: number | null, height: number | null, className: string) {
	const img = document.createElement('img');
	img.className = className;
	img.src = src;
	img.alt = '';
	img.decoding = 'async';
	img.loading = 'lazy';
	if (width && height) {
		img.width = width;
		img.height = height;
	}
	return img;
}

/** An image in the document: ready asset, local preview while uploading, or a placeholder. */
class ImageWidget extends WidgetType {
	constructor(
		readonly id: string,
		readonly src: string | null,
		readonly width: number | null,
		readonly height: number | null,
		readonly note: string | null
	) {
		super();
	}
	eq(other: ImageWidget) {
		return other.id === this.id && other.src === this.src && other.note === this.note;
	}
	toDOM() {
		const wrap = document.createElement('span');
		wrap.className = 'img-wrap';
		if (this.src) wrap.appendChild(imageElement(this.src, this.width, this.height, 'img'));
		if (this.note || !this.src) {
			const note = document.createElement('span');
			note.className = this.src ? 'img-note' : 'asset';
			note.textContent = this.note ?? '[画像]';
			wrap.appendChild(note);
		}
		return wrap;
	}
	ignoreEvent() {
		return false;
	}
}

class LabelWidget extends WidgetType {
	constructor(
		readonly text: string,
		readonly className: string
	) {
		super();
	}
	eq(other: LabelWidget) {
		return other.text === this.text && other.className === this.className;
	}
	toDOM() {
		const span = document.createElement('span');
		span.className = this.className;
		span.textContent = this.text;
		return span;
	}
}

const hide = Decoration.replace({});
const muted = Decoration.mark({ class: 'mk' });

function inlineDecorations(
	nodes: Inline[],
	base: number,
	active: boolean,
	data: LiveData,
	out: Range<Decoration>[],
	local: LiveOptions['localImage']
) {
	const conceal = (from: number, to: number) => {
		if (to <= from) return;
		out.push((active ? muted : hide).range(base + from, base + to));
	};
	const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
		if (to <= from) return;
		out.push(Decoration.mark({ class: cls, attributes: attrs }).range(base + from, base + to));
	};

	for (const node of nodes) {
		switch (node.type) {
			case 'text':
				break;
			case 'code':
				conceal(node.from, node.from + 1);
				mark(node.from + 1, node.to - 1, 'ic');
				conceal(node.to - 1, node.to);
				break;
			case 'link': {
				const page = data.names[node.name];
				conceal(node.from, node.innerFrom);
				mark(node.innerFrom, node.innerTo, page ? 'lk' : 'lk missing', {
					'data-href': page ? pageHref(page) : missingHref(node.name)
				});
				conceal(node.innerTo, node.to);
				break;
			}
			case 'tag': {
				const page = data.names[node.name];
				mark(node.from, node.to, page ? 'tag' : 'tag missing', {
					'data-href': page ? pageHref(page) : missingHref(node.name)
				});
				break;
			}
			case 'url':
				conceal(node.from, node.innerFrom);
				mark(node.innerFrom, node.innerTo, 'ext', { 'data-href': node.url, 'data-ext': '1' });
				conceal(node.innerTo, node.to);
				break;
			case 'math':
				conceal(node.from, node.innerFrom);
				mark(node.innerFrom, node.innerTo, 'math');
				conceal(node.innerTo, node.to);
				break;
			case 'asset': {
				if (active) {
					mark(node.from, node.to, 'asset');
					break;
				}
				const ready = data.assets[node.id];
				const pending = local(node.id);
				const widget = ready?.url
					? new ImageWidget(node.id, ready.url, ready.width, ready.height, null)
					: pending
						? new ImageWidget(
								node.id,
								pending.preview,
								null,
								null,
								pending.status === 'failed' ? (pending.error ?? '送信に失敗しました') : '送信中…'
							)
						: new ImageWidget(node.id, null, null, null, null);
				out.push(Decoration.replace({ widget }).range(base + node.from, base + node.to));
				break;
			}
			default: {
				const cls =
					node.type === 'strong'
						? `b${node.weight === 2 ? ' w2' : (node.weight ?? 0) >= 3 ? ' w3' : ''}`
						: node.type === 'em'
							? 'i'
							: node.type === 'strike'
								? 'st'
								: 'u';
				conceal(node.from, node.innerFrom);
				mark(node.innerFrom, node.innerTo, cls);
				inlineDecorations(node.children, base, active, data, out, local);
				conceal(node.innerTo, node.to);
			}
		}
	}
}

function lineDecorations(
	line: Line,
	from: number,
	active: boolean,
	data: LiveData,
	out: Range<Decoration>[],
	local: LiveOptions['localImage']
) {
	const attributes = line.ordered !== undefined ? { 'data-n': String(line.ordered) } : undefined;
	out.push(Decoration.line({ class: lineClass(line, active), attributes }).range(from));
	const end = from + line.text.length;

	if (line.kind === 'code' || line.kind === 'blank') return;
	if (line.kind === 'code-open' || line.kind === 'code-close' || line.kind === 'hr') {
		if (!active && end > from) {
			const label = line.kind === 'code-open' ? (line.lang ?? '') : '';
			out.push(
				Decoration.replace({ widget: new LabelWidget(label, 'code-label') }).range(from, end)
			);
		}
		return;
	}
	if (!active && line.contentFrom > 0) out.push(hide.range(from, from + line.contentFrom));
	if (active && line.contentFrom > 0 && line.kind !== 'text')
		out.push(muted.range(from, from + line.contentFrom));

	const preview = line.url ? data.previews[line.url] : undefined;
	if (!active && line.video) {
		out.push(
			Decoration.replace({ widget: new VideoWidget(line.video, preview) }).range(
				from + line.contentFrom,
				end
			)
		);
		return;
	}
	if (!active && preview?.ok && preview.title) {
		out.push(
			Decoration.replace({ widget: new CardWidget(line.url!, preview) }).range(
				from + line.contentFrom,
				end
			)
		);
		return;
	}
	inlineDecorations(line.inlines, from, active, data, out, local);
}

function activeLines(state: EditorState): Set<number> {
	const lines = new Set<number>();
	if (!state.field(focusField)) return lines;
	for (const r of state.selection.ranges) {
		const first = state.doc.lineAt(r.from).number;
		const last = state.doc.lineAt(r.to).number;
		for (let n = first; n <= last; n++) lines.add(n);
	}
	return lines;
}

function build(
	state: EditorState,
	data: LiveData,
	local: LiveOptions['localImage']
): DecorationSet {
	const parsed = state.field(parsedField);
	const active = activeLines(state);
	const out: Range<Decoration>[] = [];
	for (const line of parsed.lines) {
		const docLine = state.doc.line(line.index + 1);
		lineDecorations(line, docLine.from, active.has(docLine.number), data, out, local);
	}
	return Decoration.set(out, true);
}

/** Enter keeps the indentation and list marker; on an empty item it ends the list. */
function continueList(view: EditorView): boolean {
	const { state } = view;
	if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
	const pos = state.selection.main.head;
	const line = state.doc.lineAt(pos);
	const m = /^([ \t\u3000]*)(?:([-*+])|(\d{1,9})([.)]))?(\s*)/.exec(line.text)!;
	const [prefix, indent, bullet, num, numSep, gap] = m;
	if (!indent && !bullet && !num) return false;
	if (pos < line.from + prefix.length) return false;
	if (line.text.slice(prefix.length).trim() === '' && pos === line.to) {
		// Empty item: drop the marker (or one indent level) instead of adding a new line.
		const next = bullet || num ? indent : indent.slice(1);
		view.dispatch({
			changes: { from: line.from, to: line.to, insert: next },
			selection: { anchor: line.from + next.length }
		});
		return true;
	}
	const marker = bullet
		? `${bullet}${gap || ' '}`
		: num
			? `${Number(num) + 1}${numSep}${gap || ' '}`
			: '';
	const insert = `\n${indent}${marker}`;
	view.dispatch(state.replaceSelection(insert), { scrollIntoView: true, userEvent: 'input' });
	return true;
}

function completionSource(options: LiveOptions) {
	return async (context: CompletionContext): Promise<CompletionResult | null> => {
		if (context.view?.composing) return null; // never interfere with IME conversion
		const line = context.state.doc.lineAt(context.pos);
		const before = line.text.slice(0, context.pos - line.from);
		const bracket = /\[([^[\]`]*)$/.exec(before);
		const tag = /(^|\s)#([^\s#[\]`]*)$/.exec(before);
		if (!bracket && !tag) return null;
		const query = bracket ? bracket[1] : tag![2];
		if (bracket && /^(https?:|asset:|\$ |[*/\-_]+ )/.test(query)) return null;
		const from = context.pos - query.length;

		const controller = new AbortController();
		context.addEventListener('abort', () => controller.abort());
		let titles: TitleSuggestionDto[];
		try {
			titles = await options.suggest(query, controller.signal);
		} catch {
			return null;
		}
		const closes = context.state.sliceDoc(context.pos, context.pos + 1) === ']';
		return {
			from,
			options: titles.map((t) => ({
				label: t.title,
				detail: t.alias ? '別名' : undefined,
				apply: (view: EditorView, _c: unknown, applyFrom: number, applyTo: number) => {
					if (bracket) {
						const insert = closes ? t.title : `${t.title}]`;
						view.dispatch({
							changes: { from: applyFrom, to: applyTo, insert },
							selection: EditorSelection.cursor(applyFrom + insert.length + (closes ? 1 : 0)),
							userEvent: 'input.complete'
						});
					} else {
						// Titles with spaces cannot be tags; use a bracket link instead.
						const insert = /\s/.test(t.title) ? `[${t.title}]` : `#${t.title}`;
						view.dispatch({
							changes: { from: applyFrom - 1, to: applyTo, insert },
							selection: EditorSelection.cursor(applyFrom - 1 + insert.length),
							userEvent: 'input.complete'
						});
					}
				}
			})),
			validFor: bracket ? /^[^[\]`]*$/ : /^[^\s#[\]`]*$/
		};
	};
}

export interface LivePreview {
	extension: Extension;
	/** Merges new data (e.g. an uploaded image) or just redraws (upload progress). */
	refresh(view: EditorView, added?: Partial<LiveData>): void;
}

export function livePreview(options: LiveOptions): LivePreview {
	let data = options.data;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const asked = new Set<string>();

	const decorations = StateField.define<DecorationSet>({
		create: (state) => build(state, data, options.localImage),
		update(value, tr) {
			for (const e of tr.effects) if (e.is(dataChanged)) data = e.value;
			if (
				tr.docChanged ||
				tr.selection ||
				tr.effects.some((e) => e.is(dataChanged) || e.is(focusChanged))
			) {
				return build(tr.state, data, options.localImage);
			}
			return value;
		},
		provide: (f) => EditorView.decorations.from(f)
	});

	/** Resolves newly typed link names and card URLs in the background. */
	let primed = false;
	const lookup = EditorView.updateListener.of((update) => {
		// First update (e.g. focus) also checks names in a restored draft.
		if (!update.docChanged && primed) return;
		primed = true;
		clearTimeout(pending);
		pending = setTimeout(async () => {
			const parsed = update.view.state.field(parsedField);
			const names = parsed.links.filter((n) => !(n in data.names) && !asked.has(`n:${n}`));
			const urls = parsed.cards.filter((u) => !(u in data.previews) && !asked.has(`u:${u}`));
			if (names.length === 0 && urls.length === 0) return;
			names.forEach((n) => asked.add(`n:${n}`));
			urls.forEach((u) => asked.add(`u:${u}`));
			const added = await options
				.fetchMissing({ names, urls })
				.catch(() => ({}) as Partial<LiveData>);
			const next = {
				...data,
				names: { ...data.names, ...added.names },
				previews: { ...data.previews, ...added.previews }
			};
			update.view.dispatch({ effects: dataChanged.of(next) });
		}, 600);
	});

	const clicks = EditorView.domEventHandlers({
		mousedown(event, view) {
			const target = (event.target as HTMLElement).closest<HTMLElement>('[data-href]');
			if (!target || event.button !== 0) return false;
			const pos = view.posAtDOM(target);
			const lineNo = view.state.doc.lineAt(pos).number;
			// On the line being edited a click places the cursor, unless Cmd/Ctrl is held.
			if (activeLines(view.state).has(lineNo) && !(event.metaKey || event.ctrlKey)) return false;
			event.preventDefault();
			options.navigate(target.dataset.href!, target.dataset.ext === '1');
			return true;
		}
	});

	const extension = [
		focusField,
		EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing)),
		parsedField,
		decorations,
		lookup,
		clicks,
		indentUnit.of(' '),
		EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['[', '(', '`'] } }]),
		closeBrackets(),
		autocompletion({ override: [completionSource(options)], activateOnTyping: true, icons: false }),
		keymap.of([{ key: 'Enter', run: continueList }, ...closeBracketsKeymap, ...completionKeymap])
	];

	return {
		extension,
		refresh(view, added = {}) {
			const next: LiveData = {
				names: { ...data.names, ...added.names },
				previews: { ...data.previews, ...added.previews },
				assets: { ...data.assets, ...added.assets }
			};
			view.dispatch({ effects: dataChanged.of(next) });
		}
	};
}
